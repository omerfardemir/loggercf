/** Header names and checks shared by `useLogger` and the fetch wrappers. Internal. */

/**
 * The header `useLogger` echoes the Request ID in, and `forwardRequestId` sends it in.
 */
export const REQUEST_ID_HEADER = 'X-Request-Id'

/**
 * A value `Headers#set` accepts and sends unchanged: printable ASCII with no leading or
 * trailing space (`Headers` would trim it, and the header and the log line would differ).
 * Anything else is left out rather than making a call throw.
 */
export const SAFE_HEADER_VALUE = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/
