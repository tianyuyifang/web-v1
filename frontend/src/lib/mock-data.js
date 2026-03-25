// Mock data for previewing UI without backend

export const mockUser = {
  id: "user-1",
  username: "demo_user",
  email: "demo@example.com",
};

export const mockSongs = [
  {
    id: "song-1",
    title: "月亮代表我的心",
    artist: "邓丽君",
    duration: 240,
    filePath: "月亮代表我的心 - 邓丽君.mp3",
    lyrics:
      "[00:12.00]你问我爱你有多深\n[00:16.00]我爱你有几分\n[00:20.00]我的情也真\n[00:24.00]我的爱也真\n[00:28.00]月亮代表我的心\n[00:35.00]你问我爱你有多深\n[00:39.00]我爱你有几分",
    starts: "0|25|50|75",
    clips: [
      { id: "clip-1", start: 0, length: 25 },
      { id: "clip-2", start: 25, length: 25 },
      { id: "clip-3", start: 50, length: 25 },
    ],
  },
  {
    id: "song-2",
    title: "甜蜜蜜",
    artist: "邓丽君",
    duration: 210,
    filePath: "甜蜜蜜 - 邓丽君.mp3",
    lyrics:
      "[00:10.00]甜蜜蜜 你笑得甜蜜蜜\n[00:15.00]好像花儿开在春风里\n[00:20.00]开在春风里\n[00:25.00]在哪里 在哪里见过你",
    starts: "0|25|50",
    clips: [
      { id: "clip-4", start: 0, length: 25 },
      { id: "clip-5", start: 25, length: 25 },
    ],
  },
  {
    id: "song-3",
    title: "夜曲",
    artist: "周杰伦",
    duration: 285,
    filePath: "夜曲 - 周杰伦.mp3",
    lyrics:
      "[00:30.00]一群嗜血的蚂蚁被腐肉所吸引\n[00:35.00]我面无表情 看孤独的风景\n[00:40.00]失去你 爱恨开始分明\n[00:45.00]失去你 还有什么事好关心",
    starts: "0|25|50|75|100",
    clips: [
      { id: "clip-6", start: 0, length: 25 },
      { id: "clip-7", start: 25, length: 25 },
      { id: "clip-8", start: 50, length: 20 },
    ],
  },
  {
    id: "song-4",
    title: "稻香",
    artist: "周杰伦",
    duration: 223,
    filePath: "稻香 - 周杰伦.mp3",
    lyrics:
      "[00:18.00]对这个世界如果你有太多的抱怨\n[00:23.00]跌倒了就不敢继续往前走\n[00:28.00]为什么人要这么的脆弱 堕落",
    starts: "0|25",
    clips: [
      { id: "clip-9", start: 0, length: 25 },
      { id: "clip-10", start: 25, length: 25 },
    ],
  },
  {
    id: "song-5",
    title: "青花瓷",
    artist: "周杰伦",
    duration: 239,
    filePath: "青花瓷 - 周杰伦.mp3",
    lyrics:
      "[00:22.00]素胚勾勒出青花笔锋浓转淡\n[00:27.00]瓶身描绘的牡丹一如你初妆\n[00:32.00]冉冉檀香透过窗心事我了然",
    starts: "0|25|50",
    clips: [
      { id: "clip-11", start: 0, length: 25 },
      { id: "clip-12", start: 25, length: 25 },
    ],
  },
  {
    id: "song-6",
    title: "千里之外",
    artist: "周杰伦_费玉清",
    duration: 312,
    filePath: "千里之外 - 周杰伦_费玉清.mp3",
    lyrics:
      "[00:25.00]屋檐如悬崖 风铃如沧海\n[00:30.00]我等燕归来\n[00:35.00]时间被安排 演一场意外\n[00:40.00]你悄然走开",
    starts: null,
    clips: [],
  },
  {
    id: "song-7",
    title: "小幸运",
    artist: "田馥甄",
    duration: 293,
    filePath: "小幸运 - 田馥甄.mp3",
    lyrics:
      "[00:30.00]我听见雨滴落在青青草地\n[00:35.00]我听见远方下课钟声响起\n[00:40.00]可是我没有听见你的声音",
    starts: "0|25",
    clips: [{ id: "clip-13", start: 0, length: 25 }],
  },
  {
    id: "song-8",
    title: "告白气球",
    artist: "周杰伦",
    duration: 215,
    filePath: "告白气球 - 周杰伦.mp3",
    lyrics:
      "[00:15.00]塞纳河畔 左岸的咖啡\n[00:20.00]我手一杯 品尝你的美\n[00:25.00]留下唇印的嘴",
    starts: "0|20",
    clips: [
      { id: "clip-14", start: 0, length: 20 },
      { id: "clip-15", start: 20, length: 25 },
    ],
  },
];

function buildPlaylistClip(clip, song, position, overrides = {}) {
  return {
    id: `pc-${clip.id}`,
    clipId: clip.id,
    position,
    speed: 1.0,
    pitch: 0,
    colorTag: null,
    comment: null,
    ...overrides,
    clip: {
      ...clip,
      lyrics: song.lyrics,
      song: {
        id: song.id,
        title: song.title,
        artist: song.artist,
        duration: song.duration,
        filePath: song.filePath,
      },
    },
  };
}

export const mockPlaylists = [
  {
    id: "pl-1",
    name: "经典老歌精选",
    description: "最爱的经典华语歌曲片段",
    isPublic: false,
    isOwner: true,
    isShared: false,
    canCopy: false,
    shares: [
      { id: "user-2", username: "friend1", email: "friend1@example.com" },
    ],
    copyPermissions: [],
    clips: [
      buildPlaylistClip(mockSongs[0].clips[0], mockSongs[0], 0, {
        colorTag: "#FF5733",
        comment: "经典开场",
      }),
      buildPlaylistClip(mockSongs[0].clips[1], mockSongs[0], 1, {
        speed: 0.75,
        colorTag: "#3498DB",
      }),
      buildPlaylistClip(mockSongs[1].clips[0], mockSongs[1], 2, {
        colorTag: "#2ECC71",
        comment: "甜蜜蜜最好听的部分",
      }),
      buildPlaylistClip(mockSongs[1].clips[1], mockSongs[1], 3),
      buildPlaylistClip(mockSongs[2].clips[0], mockSongs[2], 4, {
        pitch: 2,
        colorTag: "#9B59B6",
        comment: "夜曲前奏",
      }),
      buildPlaylistClip(mockSongs[2].clips[1], mockSongs[2], 5, {
        speed: 1.25,
      }),
    ],
  },
  {
    id: "pl-2",
    name: "周杰伦合集",
    description: "Jay Chou的经典歌曲",
    isPublic: true,
    isOwner: true,
    isShared: false,
    canCopy: false,
    shares: [],
    copyPermissions: [
      { id: "user-3", username: "jayfan", email: "jayfan@example.com" },
    ],
    clips: [
      buildPlaylistClip(mockSongs[2].clips[0], mockSongs[2], 0, {
        colorTag: "#E74C3C",
      }),
      buildPlaylistClip(mockSongs[2].clips[2], mockSongs[2], 1, {
        comment: "副歌高潮",
      }),
      buildPlaylistClip(mockSongs[3].clips[0], mockSongs[3], 2, {
        colorTag: "#F39C12",
        comment: "稻香经典",
      }),
      buildPlaylistClip(mockSongs[3].clips[1], mockSongs[3], 3),
      buildPlaylistClip(mockSongs[4].clips[0], mockSongs[4], 4, {
        colorTag: "#1ABC9C",
        pitch: -2,
      }),
      buildPlaylistClip(mockSongs[4].clips[1], mockSongs[4], 5),
      buildPlaylistClip(mockSongs[7].clips[0], mockSongs[7], 6, {
        colorTag: "#E91E63",
        comment: "告白气球开头",
      }),
      buildPlaylistClip(mockSongs[7].clips[1], mockSongs[7], 7, {
        speed: 1.5,
      }),
    ],
  },
  {
    id: "pl-3",
    name: "朋友分享的歌单",
    description: "来自好友推荐",
    isPublic: false,
    isOwner: false,
    isShared: true,
    canCopy: true,
    shares: [],
    copyPermissions: [],
    clips: [
      buildPlaylistClip(mockSongs[6].clips[0], mockSongs[6], 0, {
        colorTag: "#3498DB",
        comment: "小幸运超好听",
      }),
      buildPlaylistClip(mockSongs[0].clips[2], mockSongs[0], 1, {
        colorTag: "#2ECC71",
      }),
    ],
  },
  {
    id: "pl-4",
    name: "公开热门歌单",
    description: "大家都在听的歌",
    isPublic: true,
    isOwner: false,
    isShared: false,
    canCopy: false,
    shares: [],
    copyPermissions: [],
    clips: [
      buildPlaylistClip(mockSongs[4].clips[0], mockSongs[4], 0),
      buildPlaylistClip(mockSongs[2].clips[1], mockSongs[2], 1),
      buildPlaylistClip(mockSongs[3].clips[0], mockSongs[3], 2),
    ],
  },
];

export const mockLikedClips = [
  "pl-1:clip-1",
  "pl-1:clip-4",
  "pl-2:clip-6",
  "pl-2:clip-9",
  "pl-2:clip-14",
  "pl-3:clip-13",
];
