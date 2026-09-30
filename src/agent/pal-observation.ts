import type { CognitiveFrameFacts } from './cognitive-frame.js'
export interface PalStatus {
  /** PAL 子系统运行档（配置面事实）。命名为 palMode 而非 mode：frame 序列化里
   *  "mode" 是 structureFlow 控制结果的保留字样，replay 自洽守卫按字面禁用
   *  （loop.test.ts「frame 不含控制结果」），同名字段会让 v2 记录撞上该硬线。 */
  palMode: 'off' | 'shadow' | 'active'
  toolAvailable: boolean
  state: 'disabled' | 'unavailable' | 'idle' | 'active' | 'error'
}
export function observePal(mode: PalStatus['palMode'], toolAvailable: boolean, read: () => CognitiveFrameFacts['pal']) {
  try {
    const pal = read()
    if (pal && pal.activeCases > 0) return { pal, palStatus: { palMode: mode, toolAvailable, state: 'active' as const } }
    const state = mode === 'off' ? 'disabled' : !toolAvailable ? 'unavailable' : 'idle'
    return { pal: state === 'idle' ? { activeCases: 0, anyNeedsUser: false, anyStalled: false, hasPlannedProbes: false } : null,
      palStatus: { palMode: mode, toolAvailable, state } as PalStatus }
  } catch {
    return { pal: null, palStatus: { palMode: mode, toolAvailable, state: 'error' as const } }
  }
}
