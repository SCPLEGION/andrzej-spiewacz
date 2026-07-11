import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { discordAuthorizeUrl, parseCookies, SessionSigner } from "../src/discordAuth.js";

test("discordAuthorizeUrl: builds the identify-scope OAuth2 authorize URL", () => {
  const url = new URL(discordAuthorizeUrl("123", "https://example.com/auth/discord/callback"));
  assert.equal(url.origin + url.pathname, "https://discord.com/api/oauth2/authorize");
  assert.equal(url.searchParams.get("client_id"), "123");
  assert.equal(url.searchParams.get("redirect_uri"), "https://example.com/auth/discord/callback");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("scope"), "identify");
});

test("SessionSigner: sign then verify round-trips the user id", () => {
  const signer = new SessionSigner(randomBytes(32));
  const token = signer.sign("user-1");
  assert.equal(signer.verify(token), "user-1");
});

test("SessionSigner: rejects a tampered payload", () => {
  const signer = new SessionSigner(randomBytes(32));
  const token = signer.sign("user-1");
  const [, sig] = token.split(".");
  const forged = `${Buffer.from("user-2").toString("base64url")}.${sig}`;
  assert.equal(signer.verify(forged), null);
});

test("SessionSigner: rejects a tampered signature", () => {
  const signer = new SessionSigner(randomBytes(32));
  const token = signer.sign("user-1");
  const [payload] = token.split(".");
  assert.equal(signer.verify(`${payload}.not-the-real-signature`), null);
});

test("SessionSigner: a token signed with a different secret doesn't verify", () => {
  const a = new SessionSigner(randomBytes(32));
  const b = new SessionSigner(randomBytes(32));
  assert.equal(b.verify(a.sign("user-1")), null);
});

test("SessionSigner: rejects garbage input without throwing", () => {
  const signer = new SessionSigner(randomBytes(32));
  assert.equal(signer.verify(undefined), null);
  assert.equal(signer.verify(""), null);
  assert.equal(signer.verify("no-dot-here"), null);
  assert.equal(signer.verify("...."), null);
});

test("parseCookies: parses a typical Cookie header", () => {
  assert.deepEqual(parseCookies("a=1; b=2; c=hello%20world"), { a: "1", b: "2", c: "hello world" });
});

test("parseCookies: empty/missing header yields no cookies", () => {
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies(""), {});
});

test("parseCookies: ignores malformed segments without a '='", () => {
  assert.deepEqual(parseCookies("a=1; junk; b=2"), { a: "1", b: "2" });
});
