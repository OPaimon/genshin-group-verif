module type S = {
  type t<'a>

  let pure: 'a => t<'a>
  let bind: (t<'a>, 'a => t<'b>) => t<'b>

  let getRandom: unit => t<option<Domain.quiz>>

  let reload: unit => t<result<unit, string>>
}
