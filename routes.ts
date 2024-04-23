import { ConnectRouter } from "@connectrpc/connect";
import { GithubItemType, GithubState, User } from "@prisma/client";
import { readdirSync } from "fs";
import { ElizaService } from "./gen/eliza_connect";
import prisma from "./lib/db";
import { indexDocument } from "./lib/elastic";
import { getGithubItem, listGithubItems } from "./lib/octokit";
import { checkNeedsNotifying, getYamlFile, syncGithubParticipants } from "./lib/utils";

export default (router: ConnectRouter) =>
  router.service(ElizaService, {
    async syncGithubItems() {
      try {
        const files = readdirSync("./config");

        // Use Promise.all to process all files in parallel
        await Promise.all(
          files.map(async (file) => {
            const { repos } = getYamlFile(file);
            const progress = `${files.indexOf(file) + 1} / ${files.length}`;
            console.log(`🐱🐱 ${progress} Syncing file: ${file} 🐱🐱`);

            // Use Promise.all to process all repos in parallel
            await Promise.all(
              repos.map(async (repo) => {
                const owner = repo.uri.split("/")[3];
                const name = repo.uri.split("/")[4];

                console.log(`===================== ${owner}/${name} =====================`);

                const dbRepo = await prisma.repository.upsert({
                  where: { url: repo.uri },
                  create: { name, owner, url: repo.uri },
                  update: { name, owner },
                });

                const items = await listGithubItems(owner, name);

                for await (const item of items) {
                  // const maintainers = getMaintainers({ repoUrl: repo.uri });
                  // if (maintainers.find((maintainer) => maintainer?.github === item.author.login))
                  //   continue;

                  // find user by login
                  const user = await prisma.user.findFirst({
                    where: { githubUsername: item.author.login },
                  });
                  let author: User;

                  if (!user)
                    author = await prisma.user.create({
                      data: { githubUsername: item.author.login },
                    });
                  else author = user;

                  const actionItem = await prisma.actionItem.findFirst({
                    where: { githubItems: { some: { nodeId: item.id } } },
                  });

                  const githubItem = await prisma.githubItem.upsert({
                    where: { nodeId: item.id },
                    create: {
                      author: { connect: { id: author.id } },
                      repository: { connect: { id: dbRepo.id } },
                      nodeId: item.id,
                      title: item.title,
                      body: item.bodyText,
                      number: item.number,
                      state: "open",
                      type: item.id.startsWith("I_")
                        ? GithubItemType.issue
                        : GithubItemType.pull_request,
                      createdAt: item.createdAt,
                      updatedAt: item.updatedAt,
                      lastAssignedOn: item.timelineItems.edges[0]?.node.createdAt,
                      actionItem: {
                        create: {
                          status: "open",
                          totalReplies: item.comments.totalCount ?? 0,
                          firstReplyOn: item.comments.nodes[0]?.createdAt,
                          lastReplyOn:
                            item.comments.nodes[item.comments.nodes.length - 1]?.createdAt,
                        },
                      },
                      labelsOnItems: {
                        create: item.labels.nodes.map(({ name }) => ({
                          label: { connectOrCreate: { where: { name }, create: { name } } },
                        })),
                      },
                    },
                    update: {
                      state: "open",
                      title: item.title,
                      body: item.bodyText,
                      updatedAt: item.updatedAt,
                      labelsOnItems: {
                        deleteMany: {},
                        create: item.labels.nodes.map(({ name }) => ({
                          label: { connectOrCreate: { where: { name }, create: { name } } },
                        })),
                      },
                      actionItem: {
                        update: {
                          status: actionItem?.resolvedAt ? "closed" : "open",
                          totalReplies: item.comments.totalCount,
                          firstReplyOn: item.comments.nodes[0]?.createdAt,
                          lastReplyOn:
                            item.comments.nodes[item.comments.nodes.length - 1]?.createdAt,
                          participants: { deleteMany: {} },
                        },
                      },
                    },
                    include: { actionItem: true },
                  });

                  const logins = item.participants.nodes.map((node) => node.login);
                  await syncGithubParticipants(logins, githubItem.actionItem!.id);
                  !actionItem && (await checkNeedsNotifying(githubItem.actionItem!.id));
                  indexDocument(githubItem.actionItem!.id);
                }

                console.log(
                  `===================== Syncing closed items: ${owner}/${name} =====================`
                );

                const dbItems = await prisma.githubItem.findMany({
                  where: { repositoryId: dbRepo.id, state: GithubState.open },
                });
                const ids = dbItems.map((item) => item.nodeId);
                const openIds = items.map((item) => item.id);
                const closedIds = ids.filter((id) => !openIds.includes(id));

                // close the action items that are closed on github
                for await (const id of closedIds) {
                  const res = await getGithubItem(owner, name, id);

                  const githubItem = await prisma.githubItem.update({
                    where: { nodeId: id },
                    data: {
                      state: "closed",
                      labelsOnItems: {
                        deleteMany: {},
                        create: res.node.labels.nodes.map(({ name }) => ({
                          label: { connectOrCreate: { where: { name }, create: { name } } },
                        })),
                      },
                      lastAssignedOn: res.node.timelineItems.edges[0]?.node.createdAt,
                      actionItem: {
                        update: {
                          status: "closed",
                          totalReplies: res.node.comments.totalCount,
                          firstReplyOn: res.node.comments.nodes[0]?.createdAt,
                          lastReplyOn:
                            res.node.comments.nodes[res.node.comments.nodes.length - 1]?.createdAt,
                          resolvedAt: res.node.closedAt,
                          participants: { deleteMany: {} },
                        },
                      },
                    },
                    include: { actionItem: { include: { participants: true } } },
                  });

                  const logins = res.node.participants.nodes.map((node) => node.login);
                  await syncGithubParticipants(logins, githubItem.actionItem!.id);
                  indexDocument(githubItem.actionItem!.id, { timesResolved: 1 });
                }

                console.log(`✅ DONE: ${owner}/${name} ✅`);
              })
            );

            console.log(`✅ DONE: ${file} ✅`);
          })
        );

        console.log("✅✅✅✅ Syncing done ✅✅✅✅");

        return { response: "ok" };
      } catch (err) {
        console.log("❌❌❌❌ Syncing failed ❌❌❌❌");
        console.error(err);
        return { response: err.message };
      }
    },
    async assignActionItem(req) {
      const { actionId, userId } = req;
      const user = await prisma.user.findFirst({ where: { slackId: userId } });
      if (!user) return { response: "User not found" };

      const actionItem = await prisma.actionItem.findFirst({ where: { id: actionId } });
      if (!actionItem) return { response: "Action item not found" };

      await prisma.actionItem.update({
        where: { id: actionId },
        data: { assigneeId: user.id, assignedOn: new Date() },
      });

      return { response: "ok" };
    },
    async resolveActionItem(req) {
      const { actionId, reason } = req;

      const actionItem = await prisma.actionItem.findFirst({ where: { id: actionId } });
      if (!actionItem) return { response: "Action item not found" };

      await prisma.actionItem.update({
        where: { id: actionId },
        data: { status: "closed", flag: "resolved", resolvedAt: new Date(), reason },
      });

      return { response: "ok" };
    },
    async irrelevantActionItem(req) {
      const { actionId, reason } = req;

      const actionItem = await prisma.actionItem.findFirst({ where: { id: actionId } });
      if (!actionItem) return { response: "Action item not found" };

      await prisma.actionItem.update({
        where: { id: actionId },
        data: { status: "closed", flag: "irrelevant", resolvedAt: new Date(), reason },
      });

      return { response: "ok" };
    },
    async updateNotes(req) {
      const { actionId, note } = req;

      await prisma.actionItem.update({
        where: { id: actionId },
        data: { notes: note },
      });

      return { response: "ok" };
    },
    async snoozeActionItem(req) {
      const { actionId, datetime, reason, userId } = req;

      const user = await prisma.user.findFirst({ where: { slackId: userId } });
      if (!user) return { response: "User not found" };

      await prisma.actionItem.update({
        where: { id: actionId },
        data: {
          snoozeCount: { increment: 1 },
          snoozedUntil: new Date(datetime),
          snoozedById: user.id,
          reason,
        },
      });

      return { response: "ok" };
    },
    async followUpActionItem(req) {
      const { actionId, datetime, reason, userId } = req;

      const action = await prisma.actionItem.findFirst({ where: { id: actionId } });
      if (!action) return { response: "Action item not found" };

      const user = await prisma.user.findFirst({ where: { slackId: userId } });
      if (!user) return { response: "User not found" };

      const alreadyFollowingUp = await prisma.followUp.findFirst({
        where: { parentId: actionId },
        orderBy: { date: "desc" },
      });

      // We only update the current follow up if it's in the future, otherwise we always create a new one
      if (alreadyFollowingUp && alreadyFollowingUp.date > new Date()) {
        await prisma.followUp.update({
          where: {
            parentId_nextItemId: { parentId: actionId, nextItemId: alreadyFollowingUp.nextItemId },
          },
          data: {
            date: datetime,
            nextItem: {
              create: {
                status: "followUp",
                totalReplies: 0,
                snoozedUntil: datetime,
                snoozedById: user.id,
                assigneeId: action.assigneeId,
                notes: reason ?? "",
              },
              update: {
                status: "followUp",
                totalReplies: 0,
                snoozedUntil: datetime,
                snoozedById: user.id,
                assigneeId: action.assigneeId,
                notes: reason ?? "",
              },
            },
          },
        });
      } else {
        await prisma.followUp.create({
          data: {
            parent: { connect: { id: actionId } },
            date: datetime,
            nextItem: {
              create: {
                status: "followUp",
                totalReplies: 0,
                snoozedUntil: datetime,
                snoozedById: user.id,
                assigneeId: action.assigneeId,
                notes: reason ?? "",
              },
            },
          },
        });
      }

      return { response: "ok" };
    },
    async getSlackActionItem(req) {
      const { slackId } = req;

      const actionItem = await prisma.actionItem.findFirst({
        where: { slackMessages: { some: { ts: slackId } } },
      });

      return { actionId: actionItem?.id };
    },
  });
