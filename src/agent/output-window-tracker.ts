/**
 * S1 效率时间尺度：近期工具窗口内的**主轮输出增量**观测器。
 *
 * 背景（2026-10-02 修复）：convergence detector 的 tokenEfficiency 分母是
 * 「近期工具窗口条数」，分子却曾是会话**累计**输出 → 长会话里
 * tokensPerTool = 累计/5 爆炸 → exp(-huge) ≈ 0，健康会话被钉成停滞。
 * 累计成本对「这五个工具花了多少输出」是不可能的证据——窗口内的增量才是。
 *
 * 用法：与共享工具历史**同一记录点、同一触发时序**记录（每次工具调用记一次），
 * 容量必须等于历史容量——两者按位对齐才能做同窗口做差。
 *
 * 不做的事：不缓存 usage、不自己读时钟、不判断"效率好坏"（阈值归 detector）。
 */

export class OutputWindowTracker {
  /** 每个记录点对应的**窗口基线**（该记录点所在轮**之前**的累计主轮输出，最旧在前）。 */
  private samples: number[] = []
  /** 上一次观测到的累计值（= 上一轮结束时的累计）。只在累计变化时推进。 */
  private lastCumulative: number | undefined

  constructor(private readonly capacity: number) {}

  /**
   * 记一次工具调用边界。
   *
   * 基线 = **上一次观测点**的累计，即本条记录所在轮**之前**的输出；只有累计真的
   * 变化（= 换轮）才推进观测点，同一轮内的多次记录共用同一基线。
   *
   * 为什么不能用"本次调用之后"的累计当基线：`session.addUsage` 在流结束时写入
   * （turn-stream，先于工具执行），所以同一轮的 N 个工具读到的累计是同一个值——
   * 用"本轮之后"当基线时，窗口最旧样本 = 当前累计 → 增量恒 0 → tokensPerTool=0
   * → 效率恒 1.0（满分级），窗口自身的输出被整段漏掉；窗口滑动后最旧条目落在
   * 批中任一位置时同样成立。滞后到"本轮之前"即把窗口内各轮输出全部纳入增量。
   *
   * 进程内**首次**观测没有"之前"的观测点（会话起点基线不可知，可能是 0、也可能
   * 是恢复回种的 priorUsage），此时取本次累计自身作锚——宁可少算一轮，也不能把
   * 会话累计当成窗口增量（那是本缺陷的原始形态：base 一变效率就崩）。
   */
  record(cumulativeOutputTokens: number): void {
    this.samples.push(this.lastCumulative ?? cumulativeOutputTokens)
    if (this.samples.length > this.capacity) this.samples = this.samples.slice(-this.capacity)
    if (this.lastCumulative !== cumulativeOutputTokens) this.lastCumulative = cumulativeOutputTokens
  }

  /**
   * 窗口内主轮输出增量 = 当前累计 − 窗口最旧工具调用**所在轮之前**的累计。
   *
   * - 无样本（还没调用过工具）→ undefined：缺数据不给「1.0 = 很高效」的假证据，
   *   由 detector 回落到工具分类启发式。
   * - 负值（计数被重置/回种）→ 夹到 0：观测器不是断言器，异常不喂给下游。
   * - 分子与分母同为"窗口内"口径（detector 分母取窗口条数），时间尺度一致。
   * - 已知边界：进程内首个观测轮的输出不进增量（无更早观测点可锚），方向是
   *   **少算**——最多少一轮，不会把历史累计算进来（那是伪停滞的来源）。
   */
  windowDelta(cumulativeOutputTokens: number): number | undefined {
    const oldest = this.samples[0]
    if (oldest === undefined) return undefined
    return Math.max(0, cumulativeOutputTokens - oldest)
  }

  /** 当前样本数（诊断用）。 */
  size(): number {
    return this.samples.length
  }

  /** 计数重置/任务边界：清空样本与滞后基线，下一次记录重新建立基线。 */
  reset(): void {
    this.samples = []
    this.lastCumulative = undefined
  }
}
