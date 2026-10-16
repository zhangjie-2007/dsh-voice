/**
 * dsh-completion-voice —— 插件入口（薄壳）。
 *
 * 真正的实现在 ./impl.mjs。这里每次都带时间戳动态 import 一次，
 * 于是「改代码 + 触碰 profile 的 cordis.patch.yml」就能热重载插件，
 * 不需要重启 DSH（否则 ESM 模块会被宿主进程缓存住，改了不生效）。
 */

export default {
  name: 'dsh-completion-voice',

  async apply(ctx, config) {
    const url = new URL('./impl.mjs', import.meta.url)
    url.searchParams.set('t', String(Date.now()))
    const mod = await import(url.href)
    return mod.default.apply(ctx, config)
  },
}
