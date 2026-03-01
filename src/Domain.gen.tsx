/* TypeScript file generated from Domain.res by genType. */

/* eslint-disable */
/* tslint:disable */

import * as DomainJS from './Domain.res.mjs';

export type context = "In_group" | "Join_request";

export type decision = 
    "Grant_access"
  | "Punish_soft"
  | { TAG: "Punish_hard"; _0: number };

export type log_kind = 
    "Request_start"
  | "Success"
  | "Fail_timeout"
  | "Fail_error";

export abstract class Peer_user { protected opaque!: any }; /* simulate opaque types */

export abstract class Peer_group { protected opaque!: any }; /* simulate opaque types */

export abstract class Peer_channel { protected opaque!: any }; /* simulate opaque types */

export abstract class Peer_unknown { protected opaque!: any }; /* simulate opaque types */

export type Peer_id<a> = number;

export type Peer_kind = 
    { TAG: "User"; _0: Peer_id<Peer_user> }
  | { TAG: "Group"; _0: Peer_id<Peer_group> }
  | { TAG: "Channel"; _0: Peer_id<Peer_channel> };

export type Message_id = number;

export type Message_location<a> = [Peer_id<a>, Message_id];

export type CallbackQuery_id = BigInt;

export type CallbackQuery_location = 
    { TAG: "InChat"; _0: Message_location<Peer_unknown> };

export type option_with_token = { readonly optionText: string; readonly token: string };

export type session = {
  readonly id: string; 
  readonly chatId: Peer_id<Peer_unknown>; 
  readonly userId: Peer_id<Peer_user>; 
  readonly correctToken: string; 
  readonly context: context; 
  readonly optionsWithTokens: option_with_token[]; 
  readonly verificationLocation: (undefined | Message_location<Peer_unknown>)
};

export type quiz = {
  readonly id: number; 
  readonly question: string; 
  readonly options: string[]; 
  readonly correctOptionIndex: number
};

export type verification_error = 
    "User_pending"
  | "No_quizzes_available"
  | "User_on_cooldown"
  | "Invalid_callback_data"
  | "User_not_match"
  | "Incorrect_or_expired_token"
  | "Session_not_found"
  | { TAG: "State_storage_failed"; _0: string }
  | { TAG: "Session_deserialization_failed"; _0: string };

export type callback_input = {
  readonly callbackData: string; 
  readonly queryId: CallbackQuery_id; 
  readonly userId: Peer_id<Peer_user>; 
  readonly messageLocation: Message_location<Peer_unknown>
};

export type start_input = {
  readonly userId: Peer_id<Peer_user>; 
  readonly chatId: Peer_id<Peer_unknown>; 
  readonly userChatId: Peer_id<Peer_unknown>; 
  readonly userFirstName: string; 
  readonly chatTitle: (undefined | string); 
  readonly context: context
};

export const Peer_widen: <a>(peerId:Peer_id<a>) => Peer_id<Peer_unknown> = DomainJS.Peer.widen as any;

export const Peer_refine: (raw:number) => Peer_kind = DomainJS.Peer.refine as any;

export const Message_at: <a>(peerId:Peer_id<a>, rawId:number) => Message_location<a> = DomainJS.Message.at as any;

export const Peer: { widen: <a>(peerId:Peer_id<a>) => Peer_id<Peer_unknown>; refine: (raw:number) => Peer_kind } = DomainJS.Peer as any;

export const Message: { at: <a>(peerId:Peer_id<a>, rawId:number) => Message_location<a> } = DomainJS.Message as any;
