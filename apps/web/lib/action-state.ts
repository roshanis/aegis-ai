/** What a form's server action reports back: an error to show, or nothing. */
export interface ActionState {
  readonly error: string | null;
}

export const IDLE: ActionState = { error: null };
