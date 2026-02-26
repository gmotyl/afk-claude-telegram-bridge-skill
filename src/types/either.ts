import * as E from 'fp-ts/Either'
import { pipe as fpPipe } from 'fp-ts/function'

// Type re-export
export type Either<L, R> = E.Either<L, R>

// Aliases for readability
export const ok = E.right
export const err = E.left
export const isOk = E.isRight
export const isErr = E.isLeft

// Domain helpers
export const mapError = E.mapLeft
export const unwrapOr = E.getOrElse
export const fold = E.fold

// Re-export pipe for composition
export const pipe = fpPipe
