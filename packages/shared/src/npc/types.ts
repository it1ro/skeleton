/**
 * An NPC conversation as data: pure, serializable, and shared by the client and the server.
 *
 * The model never owns this state. It only re-voices a beat that the rules already decided,
 * so a conversation can be saved, replayed and tested without a language model.
 */

/** What the player did with a phrase. The judge reacts to acts, not to wording. */
export type ActKind = 'greet' | 'ask' | 'offer' | 'promise' | 'accept' | 'refuse' | 'threat' | 'claim' | 'say';

export type AskTopic = 'price' | 'test' | 'body' | 'her' | 'world' | 'name';

export type ClaimKind = 'has' | 'did' | 'knows';

export interface Claim {
  kind: ClaimKind;
  subject: string;
}

export interface Act {
  kind: ActKind;
  /** The player's own words: the judge reads them for intent, the model gets them for tone. */
  text: string;
  topic?: AskTopic;
  claim?: Claim;
}

export type Why = 'power' | 'hide' | 'memory' | 'revenge' | 'unknown';
export type TestId = 'stone' | 'night' | 'word' | 'name' | 'fear';
export type PriceId = 'venik' | 'silence' | 'death_image' | 'oath' | 'fear';
export type Stage = 'why' | 'price' | 'deal' | 'refused' | 'over';

export interface Fact {
  kind: 'test' | 'debt' | 'insult';
  text: string;
}

export interface TalkState {
  stage: Stage;
  /** 0..MAX_PATIENCE: how much empty talk she still tolerates. */
  patience: number;
  /** 0..MAX_MINUTES: every phrase costs bath time, and time costs safety. */
  minutes: number;
  why: Why;
  test: TestId | null;
  price: PriceId | null;
  facts: Fact[];
  /** One attempt to talk the price down: she answers it, but does not lower the price. */
  haggled: boolean;
}

/** One turn of the conversation: the line, its meaning, and the state after it. */
export interface Beat {
  /** Authored fallback, already good enough to ship. */
  line: string;
  /** What the line means. A model may say it differently, never say something else. */
  intent: string;
  state: TalkState;
  /** The conversation is over: the input closes. */
  end?: boolean;
}

/** Everything a model needs to sound like this character. The world's truth stays outside. */
export interface NpcCard {
  id: string;
  name: string;
  voice: string;
  knows: string[];
  hides: string[];
  wants: string[];
}

export const MAX_PATIENCE = 5;
export const MAX_MINUTES = 20;
