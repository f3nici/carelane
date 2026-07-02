/**
 * Application error with an API error code and HTTP status. Portable: carries
 * no host-specific dependency so both the server (Express error handler) and the
 * app can throw and inspect it. The server re-exports this class from its
 * middleware so `instanceof` checks stay consistent across the codebase.
 */
export class ApiError extends Error {
  /**
   * @param {number} status HTTP status code
   * @param {string} code machine-readable error code
   * @param {string} message human-readable message
   * @param {Array} [details]
   */
  constructor (status, code, message, details = []) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}
