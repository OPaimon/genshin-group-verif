@val @scope("crypto")
external randomUUID: unit => string = "randomUUID"

// Fisher–Yates — uniform, unlike sorting by a random comparator
let shuffle = (arr: array<'a>): array<'a> => {
  let a = arr->Array.copy
  for i in a->Array.length - 1 downto 1 {
    let j = (Math.random() *. Int.toFloat(i + 1))->Math.floor->Float.toInt
    let tmp = Array.getUnsafe(a, i)
    Array.setUnsafe(a, i, Array.getUnsafe(a, j))
    Array.setUnsafe(a, j, tmp)
  }
  a
}

let discard = (_value: 'a): unit => ()
