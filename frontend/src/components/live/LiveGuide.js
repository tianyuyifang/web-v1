"use client";

import { useState } from "react";

/**
 * The 唱卡 how-to, as five collapsible sections shown in place of the pairing
 * hint while no run is on — pressing 开始 clears it, so it never interrupts a
 * game. All collapsed by default; this is reference material, opened when
 * wanted, not a banner. Hardcoded Chinese to match the rest of the page, which
 * does not go through the i18n layer.
 */

function Section({ title, open, onToggle, children }) {
  return (
    <div className="border-b border-border last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-medium text-theme transition-colors hover:bg-surface-hover"
      >
        <span>{title}</span>
        <span className={`shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`}>▾</span>
      </button>
      {open ? (
        <div className="px-4 pb-4 text-sm leading-7 text-muted">{children}</div>
      ) : null}
    </div>
  );
}

export default function LiveGuide() {
  // Only one open at a time keeps a long section from pushing the rest off
  // screen; null means all collapsed, which is the default.
  const [openKey, setOpenKey] = useState(null);
  const toggle = (k) => setOpenKey((cur) => (cur === k ? null : k));

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface">
      <Section title="使用步骤" open={openKey === "steps"} onToggle={() => toggle("steps")}>
        <ol className="list-decimal space-y-2 pl-5">
          <li>在 Q你一下的工具栏中下载【自动打标 APK】，安装至安卓手机或电脑上的安卓模拟器。</li>
          <li>在该安卓设备的系统设置中，为 APK 开启 <strong className="text-theme">无障碍权限</strong>，并开启 <strong className="text-theme">后台高耗电 / 高性能模式</strong>（各品牌名称不同），以避免系统在后台关闭 APK。</li>
          <li>使用听歌设备打开 Q你一下网页（推荐 Safari 或其他默认浏览器），在账户页面的音乐账号扫码登录 QQ 音乐和网易云音乐。</li>
          <li>在听歌设备网页右上角列表中点击「未连接」，获取配对码。</li>
          <li>在安卓手机 / 模拟器的 APK 中输入配对码。连接成功后，使用该设备进入 QNI 观战或对局，识别开始。</li>
        </ol>
      </Section>

      <Section title="设备说明" open={openKey === "devices"} onToggle={() => toggle("devices")}>
        <p>本功能涉及两类设备：</p>
        <ul className="mt-2 list-disc space-y-1.5 pl-5">
          <li><strong className="text-theme">识别设备</strong>：安卓手机或模拟器。需安装 APK 并进入 QNI 房间（本人对局或小号观战均可），用于读取游戏画面、识别唱卡。</li>
          <li><strong className="text-theme">听歌设备</strong>：任意可运行浏览器的手机、平板或电脑，用于打开 Q你一下网页。</li>
        </ul>
        <p className="mt-3">除识别设备须为安卓手机 / 模拟器外，游玩设备与听歌设备均无限制。请根据您游玩 QNI 的设备参考以下配置：</p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-b border-border text-left text-muted">
                <th className="py-1.5 pr-3 font-medium">QNI 设备</th>
                <th className="py-1.5 font-medium">配置方式</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-border/50">
                <td className="py-2 pr-3 align-top text-theme">安卓手机</td>
                <td className="py-2">APK 直接安装于游玩设备，游玩过程中可同步识别，而听歌需用其他设备（不能单设备玩 QNI）</td>
              </tr>
              <tr className="border-b border-border/50">
                <td className="py-2 pr-3 align-top text-theme">iPhone</td>
                <td className="py-2">iPhone 无法安装 APK，需另行准备一台安卓手机或电脑模拟器，以小号进入同一房间观战；游玩与听歌设备则均不受影响</td>
              </tr>
              <tr>
                <td className="py-2 pr-3 align-top text-theme">电脑模拟器</td>
                <td className="py-2">APK 安装于同一模拟器即可，听歌设备不受影响</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="识别结果" open={openKey === "results"} onToggle={() => toggle("results")}>
        <p>唱卡识别结果分为三类：</p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-b border-border text-left text-muted">
                <th className="py-1.5 pr-3 font-medium">分类</th>
                <th className="py-1.5 font-medium">说明</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-border/50">
                <td className="py-2 pr-3 align-top font-medium text-green-400">已确认</td>
                <td className="py-2">歌名、歌手与游戏显示完全一致</td>
              </tr>
              <tr className="border-b border-border/50">
                <td className="py-2 pr-3 align-top font-medium text-yellow-500/90">未确认</td>
                <td className="py-2">歌名或歌手有一项不匹配，尚未人工核查</td>
              </tr>
              <tr>
                <td className="py-2 pr-3 align-top font-medium text-red-400">未配置</td>
                <td className="py-2">该歌曲暂未收录于曲库，无法播放；由后台自动收集，每 24 小时统一配置一轮</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="常见问题" open={openKey === "faq"} onToggle={() => toggle("faq")}>
        <div className="space-y-4">
          <div>
            <p className="font-medium text-theme">Q1：识别过程中偶尔漏歌（极限抢唱 / 两军对决缺少一首歌、唱卡有时未出现）？</p>
            <p className="mt-1">请依次自查：</p>
            {/* Ordered, because the first step is also the diagnosis: whether a
                refresh brings the songs back says which side to look at next —
                the phone doing the recognising, or the browser showing them. */}
            <ol className="mt-1.5 list-decimal space-y-2.5 pl-5">
              <li>手动刷新页面，查看刚刚缺漏的歌是否能显示出来。</li>
              <li>
                <span className="font-medium text-theme">若仍未显示</span>：检查安卓设备（手机 / 模拟器）
                <ul className="mt-1.5 list-disc space-y-1.5 pl-5">
                  <li>确认安卓手机 / 模拟器已为自动打标 APK 开启 <strong className="text-theme">后台高耗电 / 高性能模式</strong>，避免 APK 被系统在后台限流；</li>
                  <li>检查自动打标 APP 是否已更新至最新版本。</li>
                  <li>确认安卓手机是否在同步运行 QNI / Q你一下，会不会在性能上出现卡顿。</li>
                </ul>
              </li>
              <li>
                <span className="font-medium text-theme">若刷新后能出现缺漏歌曲</span>：
                <ul className="mt-1.5 list-disc space-y-1.5 pl-5">
                  <li>如果始终出现此类不及时显示的问题，可以考虑更换浏览器，推荐使用 <strong className="text-theme">Safari、Chrome 或系统自带浏览器</strong>。想追求更好的体验，可以考虑用电脑或平板使用网页。</li>
                </ul>
              </li>
            </ol>
            <p className="mt-2.5">如果上述检查都没有作用，可以联系管理员进一步排查原因。</p>
          </div>
          <div>
            <p className="font-medium text-theme">Q2：变调、高音质、去伴奏等功能出现卡顿或延时？</p>
            <p className="mt-1">上述功能的处理速度与设备性能、网络状况相关，整体表现排序为：<strong className="text-theme">电脑优于手机，安卓优于苹果</strong>。此外，部分浏览器存在限流，建议使用 <strong className="text-theme">Safari、Chrome 或系统自带浏览器</strong> 打开网页，尽量勿通过微信 / QQ 内直接打开。</p>
          </div>
          <div>
            <p className="font-medium text-theme">Q3：刚打开唱卡功能时，无法立刻读取数据？</p>
            <p className="mt-1">自动打标 APK 切换传输对象存在固定的时长频率，该问题正在持续优化中。现阶段建议：<strong className="text-theme">进入对局前及时开启唱卡功能开关</strong>；对于同时使用歌 P 打标与唱卡功能的用户，可养成「歌 P 结束立即打开唱卡」的习惯，以减少识别空档。</p>
          </div>
        </div>
      </Section>

      <Section title="版本更新" open={openKey === "version"} onToggle={() => toggle("version")}>
        <p>请及时更新自动打标 APK 至最新版本，以获得完整功能与最佳识别效果。</p>
        <ul className="mt-2 list-disc space-y-1.5 pl-5">
          <li><strong className="text-theme">v3.3（最新）</strong>：玩游戏的安卓手机可以边玩边识别了 —— 自己唱的歌也能被识别，不再需要第二台设备挂房间。</li>
          <li><strong className="text-theme">v3.2</strong>：修复演唱歌词偶尔丢失的问题，歌词匹配更完整。</li>
          <li><strong className="text-theme">v3.1 及更早</strong>：仅支持识别他人演唱，且演唱歌词可能丢失，需第二台设备挂房间识别。</li>
        </ul>
        <p className="mt-3">
          更新方式：在页面右上角
          <a href="/tools" className="mx-1 underline underline-offset-2">工具页</a>
          下载最新 APK，覆盖安装后，到系统设置里关一次再打开无障碍开关即可。有问题请联系网站管理，也可加入微信群获取最新信息。
        </p>
      </Section>
    </div>
  );
}
