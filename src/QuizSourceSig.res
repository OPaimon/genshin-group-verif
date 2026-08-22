module type S = {
  type t<'a>


  let getRandom: unit => t<option<Domain.quiz>>

  let reload: unit => t<result<unit, string>>
}
