/**
 * 好友标记分享 — 谁能看谁的标记歌曲。
 *
 * 这张表只回答「能不能看」。看的内容永远现查 song_prefs（经由
 * markedSongsService，和本人的已标记 tab 同一条路），所以新增的标记对
 * 已分享的好友自动可见，取消分享后对方立刻 403。
 *
 * 单向：A 分享给 B 只让 B 看 A 的，不反向。无需对方接受 —— 分享的是
 * 自己的数据，给谁看是分享者一个人的决定；同理取消也不通知。
 */
const prisma = require('../db/client');
const { NotFoundError, ValidationError } = require('../utils/errors');

/** 两个名单一次拿全：我分享给了谁、谁分享给了我。 */
async function overview(userId) {
  const [outgoing, incoming] = await Promise.all([
    prisma.prefShare.findMany({
      where: { fromUserId: userId },
      include: { to: { select: { id: true, username: true } } },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.prefShare.findMany({
      where: { toUserId: userId },
      include: { from: { select: { id: true, username: true } } },
      orderBy: { createdAt: 'asc' },
    }),
  ]);
  return {
    outgoing: outgoing.map((s) => ({ userId: s.to.id, username: s.to.username })),
    incoming: incoming.map((s) => ({ userId: s.from.id, username: s.from.username })),
  };
}

async function share(userId, toUserId) {
  if (!toUserId || toUserId === userId) {
    throw new ValidationError({ toUserId: ['不能分享给自己'] });
  }
  const target = await prisma.user.findUnique({
    where: { id: toUserId }, select: { id: true },
  });
  if (!target) throw new NotFoundError('User');
  // 幂等：重复分享不报错，界面上表现为「已分享过」。
  await prisma.prefShare.upsert({
    where: { fromUserId_toUserId: { fromUserId: userId, toUserId } },
    create: { fromUserId: userId, toUserId },
    update: {},
  });
  return overview(userId);
}

async function revoke(userId, toUserId) {
  await prisma.prefShare.deleteMany({
    where: { fromUserId: userId, toUserId },
  });
  return overview(userId);
}

/** viewer 能不能看 owner 的标记 —— 每次请求现查，取消即刻生效。 */
async function canView(ownerId, viewerId) {
  if (ownerId === viewerId) return true;
  const row = await prisma.prefShare.findUnique({
    where: { fromUserId_toUserId: { fromUserId: ownerId, toUserId: viewerId } },
    select: { id: true },
  });
  return Boolean(row);
}

module.exports = { overview, share, revoke, canView };
