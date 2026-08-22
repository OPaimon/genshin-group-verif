module type S = {
  type t<'a>

  let pure: 'a => t<'a>
  let bind: (t<'a>, 'a => t<'b>) => t<'b>
  /// 从惰性 effect thunk 中恢复同步异常或异步 rejection。
  let recoverError: (() => t<'a>, exn => t<'a>) => t<'a>

  /// 当前 Unix epoch 毫秒。
  let nowMs: unit => t<float>
  /// 生成不可预测的会话或 callback 标识。
  let randomUUID: unit => string
  /// 返回 [0, upperExclusive) 范围内的整数。
  let randomInt: (~upperExclusive: int) => int
  /// 等待指定毫秒数。
  let sleep: float => t<unit>
  /// 启动不并入调用者 effect 链的任务；adapter 负责最终错误日志策略。
  let detach: (() => t<unit>) => unit
}
