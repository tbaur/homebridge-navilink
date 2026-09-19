/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview JSON over HTTPS against the NaviLink cloud.
 *
 * Built on `node:https` rather than `fetch` for three reasons, in ascending
 * order of how much they matter.
 *
 * A response size cap. `fetch` gives you a body you have already committed to
 * buffering, or a stream you have to cap by hand; a cap applied as bytes
 * arrive is both simpler and actually enforced. The cloud is not ours and its
 * responses are not bounded by anything we control.
 *
 * Separate connect and total deadlines. `AbortSignal.timeout` expresses one
 * instant, so it cannot say "reach the host quickly, then allow it time to
 * answer". An unreachable cloud should fail startup in seconds, not hold a
 * slot for the whole request budget.
 *
 * Control over what is logged. Everything on this path is a credential: the
 * request body carries the password, and the response body carries a JWT pair
 * and a set of AWS keys. `fetch` errors quote the URL, and a debug logger
 * wrapped round it would eventually quote a body. Here, the only thing that
 * reaches the log is the method and the path.
 */
/** A completed HTTP response, with the body still unparsed. */
export interface HttpResponse {
    status: number;
    body: string;
}
/** Per-request timing and size limits. */
export interface JsonRequestOptions {
    /** Deadline for establishing the TCP and TLS connection. */
    connectTimeoutMs: number;
    /** Deadline for the whole exchange. */
    totalTimeoutMs: number;
    /** Largest response body accepted, in bytes. */
    maxBytes: number;
    /** Extra headers. Used for the bearer-less `authorization` this API wants. */
    headers?: Readonly<Record<string, string>>;
    /** Cancels the request, so a shutdown need not wait out a deadline. */
    signal?: AbortSignal;
}
/** Performs one JSON POST. Injectable so tests never open a socket. */
export type JsonPost = (url: string, body: unknown, options: JsonRequestOptions) => Promise<HttpResponse>;
/**
 * POST a JSON body and read the response as text.
 *
 * Rejects with {@link ConnectionError} for anything that prevented an answer
 * and {@link ProtocolError} when the answer arrived but was unusable. Parsing
 * is left to the caller: a non-200 from this API still carries a JSON body
 * explaining why, and throwing on the status here would discard it.
 *
 * Redirects are not followed. The cloud does not issue them, and following one
 * would let a compromised or spoofed endpoint move a request that carries the
 * user's password to a host of its choosing.
 */
export declare const postJson: JsonPost;
/**
 * Parse a response body as JSON, or explain why it could not be.
 *
 * The excerpt in the failure message is capped and redacted: a gateway error
 * page can be a whole HTML document, and a partial JSON body from this API
 * would otherwise put a token into the log.
 */
export declare function parseJsonBody(body: string): unknown;
