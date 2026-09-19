/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview AWS Signature Version 4, for a pre-signed AWS IoT WebSocket URL.
 *
 * AWS IoT's WebSocket transport takes no password on the socket: authority is
 * the signature in the URL's query string. This plugin signs a
 * `wss://…/mqtt` URL with the temporary IAM credentials that
 * `POST /user/sign-in` hands back, and connects to that.
 *
 * Only the tiny slice of SigV4 this needs is implemented: one service, one
 * signed header, an empty payload and no request body. The full algorithm has
 * a great deal more in it, and an `@aws-sdk/*` dependency to do this would be
 * several megabytes to build one string.
 *
 * **The URL this produces is a credential.** It carries the session token, the
 * access key id and a signature over them, and anyone holding it can speak to
 * the account's IoT endpoint until it expires. It must never be logged, never
 * put in an error message, and never written to a capture. `redactSecrets`
 * knows the query parameter names, but the primary defence is that the
 * transport logs the endpoint host and never the URL.
 */
/** Temporary IAM credentials, as `POST /user/sign-in` returns them. */
export interface IotCredentials {
    accessKeyId: string;
    secretKey: string;
    sessionToken: string;
    /** The account's `…-ats.iot.<region>.amazonaws.com` endpoint. */
    endpoint: string;
    region: string;
}
/**
 * Percent-encode for a canonical request.
 *
 * `encodeURIComponent` is close but not identical to the AWS rule: it leaves
 * `*` alone, which AWS requires encoded, and it encodes `~`, which AWS
 * requires left alone. Both appear in session tokens, so getting either wrong
 * produces a signature mismatch that reads as "not authorised" and sends you
 * looking at IAM policy instead of at this function.
 */
export declare function uriEncode(value: string): string;
/** The two timestamp forms SigV4 wants, derived from one instant. */
export declare function amzTimestamps(now?: Date): {
    amzDate: string;
    dateStamp: string;
};
/**
 * Build a signed `wss://` URL for the account's IoT endpoint.
 *
 * `signHostWithPort` selects what goes in the signed `host` header. Measured
 * against the NaviLink endpoint: signing the bare host succeeds and signing
 * `host:443` does not, so the default is the bare host. The alternative is
 * kept because the two forms are both defensible readings of the SigV4 rule
 * for a default port, other AWS regions and endpoints have been reported to
 * want the other one, and the failure is indistinguishable from a wrong
 * password: a silent 403 on the upgrade. The transport tries the default and
 * then the fallback, so a user does not have to guess.
 *
 * The security token is appended *after* signing and is not part of the
 * canonical query string. That is specific to IoT's WebSocket flow and is not
 * how SigV4 normally treats `X-Amz-Security-Token`; including it in the
 * canonical string produces a signature the endpoint rejects.
 */
export declare function presignIotWebsocketUrl(credentials: IotCredentials, options?: {
    signHostWithPort?: boolean;
    now?: Date;
}): string;
