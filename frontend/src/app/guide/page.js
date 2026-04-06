"use client";

import { useLanguage } from "@/components/layout/LanguageProvider";

function Section({ id, title, children }) {
  return (
    <section id={id} className="scroll-mt-20">
      <h2 className="mb-4 text-xl font-bold text-theme">{title}</h2>
      <div className="space-y-4 text-sm leading-relaxed text-theme">{children}</div>
    </section>
  );
}

function Sub({ title, children }) {
  return (
    <div>
      <h3 className="mb-2 text-base font-semibold text-theme">{title}</h3>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function Steps({ items }) {
  return (
    <ol className="list-inside list-decimal space-y-1 text-sm text-muted">
      {items.map((item, i) => <li key={i}>{item}</li>)}
    </ol>
  );
}

function Tip({ children }) {
  return (
    <div className="rounded-lg border border-primary/20 bg-primary/5 px-4 py-3 text-xs text-muted">
      <span className="mr-1.5 font-semibold text-primary">Tip:</span>{children}
    </div>
  );
}

function P({ children }) {
  return <p className="text-muted">{children}</p>;
}

function B({ children }) {
  return <strong className="text-theme">{children}</strong>;
}

function UL({ children }) {
  return <ul className="list-inside list-disc space-y-1 text-muted">{children}</ul>;
}

function NavLinks({ items }) {
  return (
    <nav className="flex flex-wrap gap-2">
      {items.map(({ id, label }) => (
        <a
          key={id}
          href={`#${id}`}
          className="rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:border-primary hover:text-primary"
        >
          {label}
        </a>
      ))}
    </nav>
  );
}

function GuideEn() {
  return (
    <>
      <NavLinks
        items={[
          { id: "account", label: "Account" },
          { id: "playlists", label: "Playlists" },
          { id: "player", label: "Player" },
          { id: "editing", label: "Editing" },
          { id: "sharing", label: "Sharing" },
          { id: "settings", label: "Settings" },
          { id: "feedback", label: "Feedback" },
          { id: "faq", label: "FAQ" },
        ]}
      />

      <Section id="account" title="1. Account">
        <Sub title="Register">
          <Steps
            items={[
              "Go to the registration page and enter a username (2 to 30 characters) and password (min 8 characters).",
              "Click Register. Your account starts as Pending.",
              "An admin must approve your account before you can access playlists.",
            ]}
          />
          <Tip>After approval, log in and you will be redirected to your playlists.</Tip>
        </Sub>
        <Sub title="Log In">
          <Steps
            items={[
              "Enter your username and password on the login page.",
              "Click Log In. You will be taken to your playlists.",
            ]}
          />
          <Tip>Your session lasts 7 days. After that you will need to log in again.</Tip>
        </Sub>
      </Section>

      <Section id="playlists" title="2. Playlists">
        <Sub title="Browse Playlists">
          <P>Your playlists page shows three sections:</P>
          <UL>
            <li><B>My Playlists</B> — playlists you created</li>
            <li><B>Shared</B> — playlists others shared with you</li>
            <li><B>Public</B> — playlists visible to everyone</li>
          </UL>
          <P>Use the search bar to filter by name. Supports Chinese, pinyin, and pinyin initials (e.g. type 「xqg」 to find 「小情歌」).</P>
        </Sub>
        <Sub title="Create a Playlist">
          <Steps
            items={[
              "Click the 「+ New Playlist」 button in the top right.",
              "Enter a name and optional description.",
              "Check 「Public」 if you want others to see it.",
              "Click Create. You will be taken to the empty playlist.",
            ]}
          />
          <Tip>You can also import clips in bulk using the Import tab on the new playlist page.</Tip>
        </Sub>
        <Sub title="Open a Playlist">
          <P>Click any playlist card to open it. Clips display in a grid. On desktop, a sidebar on the left shows a compact list for quick navigation.</P>
          <P><B>Mobile:</B> The sidebar is hidden on small screens. Use the search bar at the top to filter clips.</P>
        </Sub>
      </Section>

      <Section id="player" title="3. Playing Clips">
        <Sub title="Playback Controls">
          <P>Each clip card has:</P>
          <UL>
            <li><B>Play / Pause</B> — the round button on the left</li>
            <li><B>Replay</B> — the circular arrow, replays from the beginning</li>
            <li><B>Volume</B> — slider next to the replay button</li>
            <li><B>Progress bar</B> — click or drag anywhere to seek</li>
            <li><B>Lyrics</B> — time-synced, highlights the current line. Click any line to jump there</li>
          </UL>
          <Tip>Only one clip plays at a time. Starting a new clip automatically pauses the previous one.</Tip>
        </Sub>
        <Sub title="Likes">
          <P>Click the heart icon to like or unlike. Likes are shared — everyone with access sees the same likes. Click 「Unlike All」 in the header to clear them all.</P>
        </Sub>
        <Sub title="Color Tags">
          <P>Colored bookmark flags in the top-right of each clip. Click 「+」 to add a color, click an existing flag to remove it. Hover to see the color name.</P>
        </Sub>
        <Sub title="Comments">
          <P>Click the comment area below the controls to add a note. Comments are visible to everyone with access.</P>
        </Sub>
        <Sub title="Column Layout">
          <P>Use the column selector (1 to 5) in the playlist header to adjust how many clips show per row. Hidden on mobile (always single-column).</P>
        </Sub>
      </Section>

      <Section id="editing" title="4. Editing a Playlist">
        <P>Click the <B>Edit</B> button in the playlist header (owner only) to activate edit mode.</P>
        <Sub title="Add Clips">
          <Steps
            items={[
              "Click 「Add Clip」 in the edit toolbar.",
              "Search for a song by name, pinyin, or initials.",
              "Pick an existing clip or click 「Create Clip」 / 「+ New」 to define a custom start time.",
              "The clip is added to the end of the playlist.",
            ]}
          />
          <Tip>Clips already in the playlist show a checkmark to avoid duplicates.</Tip>
        </Sub>
        <Sub title="Reorder Clips">
          <P>In compact view, drag clips using the handle. Or type a position number in the input field and press Enter to move a clip.</P>
        </Sub>
        <Sub title="Switch Clips">
          <P>Click 「Switch Clip」 to swap with a different clip of the same song. Speed, pitch, color tags, and comments are preserved.</P>
        </Sub>
        <Sub title="Speed and Pitch">
          <P>In edit mode, each clip shows speed (0.9x to 1.2x) and pitch (-6 to +6 semitones) controls. Changes save automatically and affect playback in real time.</P>
          <Tip>Modified speed/pitch is shown as an amber badge on the clip card.</Tip>
        </Sub>
        <Sub title="Batch Operations">
          <Steps
            items={[
              "Click 「Batch」 in the edit toolbar.",
              "Select multiple clips using checkboxes (or 「Select All」).",
              "Apply speed, pitch, color tag, or comment changes to all selected clips.",
              "Click 「Apply」 to save, or 「Remove」 to delete them.",
            ]}
          />
        </Sub>
        <Sub title="Section Labels">
          <P>In compact view, click the 「+」 between clips to add a section divider. These show as horizontal dividers and as jump buttons in the header.</P>
        </Sub>
        <Sub title="Remove and Delete">
          <P>Click the red 「Remove」 text on any clip card. To delete the entire playlist, click the red 「Delete」 button in the edit toolbar.</P>
        </Sub>
      </Section>

      <Section id="sharing" title="5. Sharing and Privacy">
        <Sub title="Public / Private">
          <P>Toggle the 「Public」 button in edit mode. Public playlists appear in the Public section for everyone. Private playlists are only visible to you and people you share with.</P>
        </Sub>
        <Sub title="Share with Users">
          <Steps
            items={[
              "Click 「Share」 in the edit toolbar.",
              "Under 「View Access」, search for a username and click to add.",
              "They will see the playlist in their 「Shared」 section.",
              "Click 「Remove」 next to a name to revoke access.",
            ]}
          />
        </Sub>
        <Sub title="Copy Permissions">
          <P>Under 「Copy Permission」 in the share modal, add users who can duplicate your playlist. They will see a 「Copy」 button on your playlist page.</P>
        </Sub>
        <Sub title="Compare Playlist">
          <P>Click 「Compare」 in the header to compare your playlist against a QQ Music or Netease playlist. Enter the platform playlist ID to see matches, mismatches, and missing songs.</P>
        </Sub>
      </Section>

      <Section id="settings" title="6. Settings">
        <Sub title="Preferences">
          <UL>
            <li><B>Language</B> — switch between English and Chinese</li>
            <li><B>Theme</B> — Dark, Light, High Contrast, or Warm</li>
            <li><B>Color Palette</B> — choose a primary color accent</li>
            <li><B>Surface Style</B> — Solid, Glass, Mono, or Gradient</li>
          </UL>
          <Tip>All preferences apply instantly — no save button needed.</Tip>
        </Sub>
        <Sub title="Account">
          <P><B>Change Username:</B> Enter a new username and your current password. You will be logged out.</P>
          <P><B>Change Password:</B> Enter your current password, then the new one (min 8 characters) twice.</P>
        </Sub>
      </Section>

      <Section id="feedback" title="7. Feedback">
        <P>Click 「Feedback」 in the nav bar to submit:</P>
        <UL>
          <li><B>Bad Song</B> — report wrong lyrics, bad audio, or wrong version</li>
          <li><B>Request Song</B> — suggest a song to add</li>
          <li><B>General</B> — bug reports, feature suggestions, or anything else</li>
        </UL>
      </Section>

      <Section id="faq" title="8. FAQ">
        <Sub title="Why can I not access anything after registering?">
          <P>New accounts start as Pending. An admin needs to approve you first.</P>
        </Sub>
        <Sub title="Can I use this on my phone?">
          <P>Yes. The layout adapts to mobile. Sidebar is hidden, single-column layout. All other features work the same.</P>
        </Sub>
        <Sub title="Why is there a delay when playing a clip?">
          <P>The first 8 clips preload on page open. Others load on-demand (~200ms). Cached after first play.</P>
        </Sub>
        <Sub title="What does the amber badge mean?">
          <P>It shows modified speed or pitch (e.g. 1.1x +2).</P>
        </Sub>
        <Sub title="How do I reorder clips?">
          <P>Enter edit mode, turn on Compact View, then drag or type a position number.</P>
        </Sub>
        <Sub title="Search not finding my song?">
          <P>Try Chinese characters, full pinyin, pinyin initials, or artist name. The Add Clip modal uses strict prefix matching.</P>
        </Sub>
      </Section>
    </>
  );
}

function GuideZh() {
  return (
    <>
      <NavLinks
        items={[
          { id: "account", label: "账号" },
          { id: "playlists", label: "播放列表" },
          { id: "player", label: "播放器" },
          { id: "editing", label: "编辑" },
          { id: "sharing", label: "分享" },
          { id: "settings", label: "设置" },
          { id: "feedback", label: "反馈" },
          { id: "faq", label: "常见问题" },
        ]}
      />

      <Section id="account" title="1. 账号">
        <Sub title="注册">
          <Steps
            items={[
              "进入注册页面，输入用户名（2 到 30 个字符）和密码（至少 8 个字符）。",
              "点击注册。账号初始状态为「待审核」。",
              "管理员审核通过后才能访问播放列表。",
            ]}
          />
          <Tip>审核通过后，登录即可跳转到播放列表页面。</Tip>
        </Sub>
        <Sub title="登录">
          <Steps
            items={[
              "在登录页面输入用户名和密码。",
              "点击登录，进入播放列表。",
            ]}
          />
          <Tip>登录有效期为 7 天，过期后需要重新登录。</Tip>
        </Sub>
      </Section>

      <Section id="playlists" title="2. 播放列表">
        <Sub title="浏览播放列表">
          <P>播放列表页面分为三个区域：</P>
          <UL>
            <li><B>我的列表</B> — 你创建的播放列表</li>
            <li><B>共享列表</B> — 别人分享给你的</li>
            <li><B>公开列表</B> — 所有人可见的</li>
          </UL>
          <P>顶部搜索栏支持中文、拼音全拼和拼音首字母（例如输入「xqg」可以找到「小情歌」）。</P>
        </Sub>
        <Sub title="创建播放列表">
          <Steps
            items={[
              "点击右上角「+ 新建播放列表」按钮。",
              "输入名称和可选的描述。",
              "勾选「公开」让所有人可见。",
              "点击创建，进入空白播放列表。",
            ]}
          />
          <Tip>也可以在新建页面使用「导入」功能批量添加片段。</Tip>
        </Sub>
        <Sub title="打开播放列表">
          <P>点击任意卡片打开。桌面端左侧有侧边栏方便快速跳转。</P>
          <P><B>手机端：</B>侧边栏隐藏，使用顶部搜索栏筛选片段。</P>
        </Sub>
      </Section>

      <Section id="player" title="3. 播放片段">
        <Sub title="播放控制">
          <P>每个片段卡片包含：</P>
          <UL>
            <li><B>播放/暂停</B> — 左侧圆形按钮</li>
            <li><B>重播</B> — 循环箭头，从头播放</li>
            <li><B>音量</B> — 滑块控制</li>
            <li><B>进度条</B> — 点击或拖拽跳转</li>
            <li><B>歌词</B> — 实时高亮，点击可跳转</li>
          </UL>
          <Tip>同时只播放一个片段，新播放会自动暂停前一个。</Tip>
        </Sub>
        <Sub title="点赞">
          <P>点击心形图标点赞或取消。点赞共享，所有有权限的用户看到相同的状态。点击「取消所有点赞」一次清除。</P>
        </Sub>
        <Sub title="颜色标签">
          <P>右上角彩色书签。点击「+」添加颜色，点击已有标记移除。悬停可看到颜色名称。</P>
        </Sub>
        <Sub title="备注">
          <P>点击控制栏下方备注区域添加笔记，所有有权限的用户可见。</P>
        </Sub>
        <Sub title="列数布局">
          <P>列数选择器（1 到 5）调整每行显示数。手机端固定单列。</P>
        </Sub>
      </Section>

      <Section id="editing" title="4. 编辑播放列表">
        <P>点击表头<B>编辑</B>按钮（仅创建者可用）进入编辑模式。</P>
        <Sub title="添加片段">
          <Steps
            items={[
              "点击编辑工具栏的「添加片段」。",
              "搜索歌曲（支持歌名、拼音、首字母）。",
              "选择已有片段或点击「创建片段」/「+ 新建」自定义起始时间。",
              "片段添加到列表末尾。",
            ]}
          />
          <Tip>已在播放列表中的片段会显示对号标记，避免重复添加。</Tip>
        </Sub>
        <Sub title="排序片段">
          <P>紧凑视图中拖拽手柄排序，或在位置编号输入框中输入新位置按回车。</P>
        </Sub>
        <Sub title="切换片段">
          <P>点击「切换片段」可替换为同一首歌的不同片段。速度、音高、颜色标签和备注会保留。</P>
        </Sub>
        <Sub title="速度和音高">
          <P>编辑模式下每个片段显示速度（0.9x 到 1.2x）和音高（-6 到 +6 半音）控制。修改自动保存，实时影响播放。</P>
          <Tip>修改过速度或音高的片段会显示琥珀色标签。</Tip>
        </Sub>
        <Sub title="批量操作">
          <Steps
            items={[
              "点击编辑工具栏的「批量」进入批量模式。",
              "用复选框选择多个片段（或「全选」）。",
              "一次性修改速度、音高、颜色标签或备注。",
              "点击「应用」保存，或「移除」删除所有选中项。",
            ]}
          />
        </Sub>
        <Sub title="分段标签">
          <P>紧凑视图中点击片段之间的「+」添加分隔线。表头会显示跳转按钮。</P>
        </Sub>
        <Sub title="移除和删除">
          <P>编辑模式下点击红色「移除」移除单个片段。点击红色「删除」删除整个播放列表。</P>
        </Sub>
      </Section>

      <Section id="sharing" title="5. 分享与隐私">
        <Sub title="公开和私密">
          <P>编辑模式下切换「公开」按钮。公开列表会出现在所有人的「公开列表」区域。私密列表仅你和被分享的用户可见。</P>
        </Sub>
        <Sub title="分享给用户">
          <Steps
            items={[
              "点击编辑工具栏的「分享」。",
              "在「查看权限」中搜索用户名添加。",
              "被分享的用户会在「共享列表」中看到该播放列表。",
              "点击「移除」取消分享。",
            ]}
          />
        </Sub>
        <Sub title="复制权限">
          <P>在分享弹窗的「复制权限」中添加允许复制你播放列表的用户。他们会看到「复制」按钮。</P>
        </Sub>
        <Sub title="对比播放列表">
          <P>点击表头的「对比」按钮，可与 QQ 音乐或网易云的歌单对比。输入平台歌单 ID 即可。</P>
        </Sub>
      </Section>

      <Section id="settings" title="6. 设置">
        <Sub title="偏好设置">
          <UL>
            <li><B>语言</B> — 中英文切换</li>
            <li><B>主题</B> — 深色、浅色、高对比度、暖色</li>
            <li><B>配色</B> — 选择主色调</li>
            <li><B>风格</B> — 实色、毛玻璃、黑白、渐变</li>
          </UL>
          <Tip>所有偏好设置即时生效，无需保存。</Tip>
        </Sub>
        <Sub title="账号">
          <P><B>修改用户名：</B>输入新用户名和当前密码。修改后会自动退出，需要用新用户名重新登录。</P>
          <P><B>修改密码：</B>输入当前密码，然后两次输入新密码（至少 8 个字符）。</P>
        </Sub>
      </Section>

      <Section id="feedback" title="7. 反馈">
        <P>点击导航栏的「反馈」提交：</P>
        <UL>
          <li><B>问题歌曲</B> — 歌词错误、音频质量差或版本不对</li>
          <li><B>歌曲请求</B> — 建议添加的歌曲</li>
          <li><B>其他建议</B> — Bug 报告、功能建议或其他反馈</li>
        </UL>
      </Section>

      <Section id="faq" title="8. 常见问题">
        <Sub title="注册后为什么无法访问？">
          <P>新账号状态为「待审核」，需管理员审核通过。</P>
        </Sub>
        <Sub title="手机上能用吗？">
          <P>可以。布局自适应。侧边栏隐藏，单列显示。其他功能相同。</P>
        </Sub>
        <Sub title="播放时为什么有延迟？">
          <P>预加载前 8 个片段。其他片段在点击播放时加载（约 200 毫秒）。首次播放后会缓存。</P>
        </Sub>
        <Sub title="琥珀色标签是什么？">
          <P>显示修改过的速度或音高（例如 1.1x +2）。</P>
        </Sub>
        <Sub title="如何排序片段？">
          <P>编辑模式 → 紧凑视图 → 拖拽或输入位置编号。</P>
        </Sub>
        <Sub title="搜索找不到歌曲？">
          <P>尝试中文、拼音全拼、拼音首字母或歌手名。添加片段弹窗使用严格前缀匹配。</P>
        </Sub>
      </Section>
    </>
  );
}

export default function GuidePage() {
  const { lang } = useLanguage();

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-theme">
          {lang === "zh" ? "使用指南" : "User Guide"}
        </h1>
        <p className="mt-1 text-sm text-muted">
          {lang === "zh"
            ? "了解如何使用 MusicClip 的各项功能"
            : "Learn how to use every feature of MusicClip"}
        </p>
      </div>

      <div className="space-y-10">
        {lang === "zh" ? <GuideZh /> : <GuideEn />}
      </div>
    </div>
  );
}
