@val @scope("crypto") 
external randomUUID: unit => string = "randomUUID"

let panic = (msg: string): 'a => {
  JsError.throwWithMessage("PANIC (unreachable): " ++ msg)
}

let todo = (msg: string): 'a => {
  JsError.throwWithMessage("TODO (not implemented): " ++ msg)
}

let discard = (_value: 'a): unit => ()

let null = discard

let unreachable = panic

let todoWith = (~_value: 'a, ~msg: string): 'b => {
  todo(msg)
}

let todo2 = (value: 'a, msg: string): 'b => {
  todoWith(~_value=value, ~msg)
}

