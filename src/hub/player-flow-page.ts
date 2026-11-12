/**
 * Loopback page for the player exchange. It runs on 127.0.0.1 only.
 * The public server does not import this module. It asks the browser wallet
 * to sign two messages. It does not send a transaction and it does not publish.
 */

export const PLAYER_FLOW_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>Player claim</title>
</head>
<body>
  <main id="content">
    <h1>Player claim</h1>
    <p id="status">Discord identify runs on this machine. The claim is not published from this page.</p>
    <section id="setup">
      <form id="claim-form" action="#content" method="post">
        <label>Wallet <input id="wallet" name="wallet" autocomplete="off" spellcheck="false"></label>
        <label>Hub <input id="hub" name="hub" autocomplete="off" spellcheck="false" placeholder="https://github.com/owner/repo"></label>
        <label>Listing id <input id="listing-id" name="listing-id" autocomplete="off" spellcheck="false"></label>
        <label>Player profile <input id="profile" name="profile" autocomplete="off" spellcheck="false"></label>
        <label>Nonce <input id="nonce" name="nonce" autocomplete="off" spellcheck="false"></label>
        <label>Expires <input id="expires" name="expires" autocomplete="off" spellcheck="false" placeholder="2027-04-01T00:00:00.000Z"></label>
        <label>Created <input id="created-at" name="created-at" autocomplete="off" spellcheck="false"></label>
        <label>Show handles <input id="show-handles" name="show-handles" type="checkbox"></label>
        <button type="button" id="begin">Continue with Discord</button>
      </form>
      <p>The Discord scope is identify. This page does not send a message to Discord.</p>
    </section>
    <section id="sign" hidden>
      <p id="subject"></p>
      <h2>Claim message</h2>
      <pre id="claim-message"></pre>
      <button type="button" id="sign-claim">Sign the claim</button>
      <h2>Attestation message</h2>
      <pre id="attestation-message"></pre>
      <button type="button" id="sign-attestation">Sign the attestation</button>
      <button type="button" id="finish">Check the profile and write files</button>
      <pre id="result"></pre>
    </section>
  </main>
  <script src="/player.js"></script>
</body>
</html>
`;

export const PLAYER_FLOW_SCRIPT = `
var ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(bytes) {
  if (!bytes || bytes.length === 0) return "";
  var digits = [0];
  for (var i = 0; i < bytes.length; i += 1) {
    var carry = bytes[i];
    for (var j = 0; j < digits.length; j += 1) {
      carry += (digits[j] || 0) << 8;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  var encoded = "";
  for (var k = 0; bytes[k] === 0 && k < bytes.length - 1; k += 1) encoded += "1";
  for (var n = digits.length - 1; n >= 0; n -= 1) encoded += ALPHABET[digits[n] || 0] || "";
  return encoded;
}

function say(text) {
  var note = document.getElementById("status");
  if (note) note.textContent = text;
}

function field(id) {
  var node = document.getElementById(id);
  return node && "value" in node ? String(node.value || "") : "";
}

function post(path, body) {
  return fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-player-flow": "1" },
    body: JSON.stringify(body),
  }).then(function (response) {
    return response.json().then(function (payload) {
      return { ok: response.ok, payload: payload };
    });
  });
}

function provider() {
  var solana = window.solana;
  if (!solana || typeof solana.signMessage !== "function") return null;
  return solana;
}

function signText(text, expectedWallet) {
  var wallet = provider();
  if (!wallet) return Promise.reject(new Error("Open a wallet that can sign a message."));
  var connect = typeof wallet.connect === "function" ? wallet.connect() : Promise.resolve();
  return connect.then(function () {
    var address = wallet.publicKey && typeof wallet.publicKey.toString === "function" ? wallet.publicKey.toString() : "";
    if (!address || address !== expectedWallet) throw new Error("The connected wallet does not match this claim.");
    return wallet.signMessage(new TextEncoder().encode(text), "utf8");
  }).then(function (signed) {
    var raw = signed && signed.signature ? signed.signature : signed;
    var bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw || []);
    if (bytes.length !== 64) throw new Error("The wallet did not return a signature.");
    return base58Encode(bytes);
  });
}

var drafts = null;
var claimSignature = "";
var attestationSignature = "";
var session = new URLSearchParams(window.location.search).get("session") || "";

var form = document.getElementById("claim-form");
if (form) form.addEventListener("submit", function (event) { event.preventDefault(); });

var begin = document.getElementById("begin");
if (begin) begin.addEventListener("click", function () {
  say("Starting Discord identify.");
  var show = document.getElementById("show-handles");
  post("/begin", {
    wallet: field("wallet"),
    hub: field("hub"),
    listingId: field("listing-id"),
    profile: field("profile"),
    nonce: field("nonce"),
    expiresAt: field("expires"),
    createdAt: field("created-at"),
    showHandles: Boolean(show && show.checked),
  }).then(function (result) {
    var url = result.payload && result.payload.authorizeUrl;
    if (!result.ok || typeof url !== "string" || url.indexOf("https://discord.com/oauth2/authorize?") !== 0 || url.indexOf("client_secret") !== -1) {
      say(result.payload && result.payload.error ? String(result.payload.error) : "Discord identify did not start.");
      return;
    }
    window.location.assign(url);
  }).catch(function () {
    say("Discord identify did not start.");
  });
});

if (session) {
  var setup = document.getElementById("setup");
  var sign = document.getElementById("sign");
  if (setup) setup.hidden = true;
  if (sign) sign.hidden = false;
  post("/messages", { session: session }).then(function (result) {
    if (!result.ok || !result.payload || !result.payload.claim || !result.payload.attestation) {
      say(result.payload && result.payload.error ? String(result.payload.error) : "The Discord proof is not ready.");
      return;
    }
    drafts = result.payload;
    var subject = document.getElementById("subject");
    var claimBox = document.getElementById("claim-message");
    var attestBox = document.getElementById("attestation-message");
    if (subject) subject.textContent = "Wallet " + result.payload.wallet + ". Listing " + result.payload.listingId + ".";
    if (claimBox) claimBox.textContent = result.payload.claim.message.utf8;
    if (attestBox) attestBox.textContent = result.payload.attestation.message.utf8;
    say("Sign the claim, then the attestation. This page does not publish either file.");
  }).catch(function () {
    say("The Discord proof is not ready.");
  });
}

var signClaim = document.getElementById("sign-claim");
if (signClaim) signClaim.addEventListener("click", function () {
  if (!drafts) {
    say("The Discord proof is not ready.");
    return;
  }
  signText(drafts.claim.message.utf8, drafts.wallet).then(function (signature) {
    claimSignature = signature;
    say("Claim signature stored on this page. It has not been published.");
  }).catch(function (error) {
    say(error && error.message ? error.message : "The claim was not signed.");
  });
});

var signAttestation = document.getElementById("sign-attestation");
if (signAttestation) signAttestation.addEventListener("click", function () {
  if (!drafts) {
    say("The Discord proof is not ready.");
    return;
  }
  signText(drafts.attestation.message.utf8, drafts.wallet).then(function (signature) {
    attestationSignature = signature;
    say("Attestation signature stored on this page. It has not been published.");
  }).catch(function (error) {
    say(error && error.message ? error.message : "The attestation was not signed.");
  });
});

var finish = document.getElementById("finish");
if (finish) finish.addEventListener("click", function () {
  if (!claimSignature || !attestationSignature) {
    say("Sign the claim and the attestation first.");
    return;
  }
  post("/finish", {
    session: session,
    claimSignature: claimSignature,
    attestationSignature: attestationSignature,
  }).then(function (result) {
    var box = document.getElementById("result");
    var payload = result.payload || {};
    var lines = [
      payload.published === false ? "Not published." : "Refused.",
      payload.profile ? "Profile " + payload.profile + "." : "",
      payload.files ? "Files " + payload.files.join(", ") + "." : "",
      payload.note ? String(payload.note) : "",
      payload.error ? String(payload.error) : "",
    ].filter(Boolean);
    if (box) box.textContent = lines.join(" ");
    say(lines[0] || "Nothing was written.");
  }).catch(function () {
    say("The profile check did not finish. Nothing was written.");
  });
});
`;
