import app from "../../../schema";
import { withCardAnswer } from "../../core/embeds";
import type { Embed } from "../../core/types";

/* A video card is YouTube's own player, behind the video's still. The app
   host lets every app's page frame YouTube's privacy-enhanced player
   (www.youtube-nocookie.com) and nothing else; the still, like a post's
   pictures, comes as bytes through the web service, so the page itself
   never asks another site for anything. */

/** The brick's answers this session, by video or post. Two cards of one
 *  video, started at different times, share it and keep their own
 *  addresses. An answer that came is kept; one that did not is forgotten,
 *  to be asked again — but not more than once a minute per card. */
const asked = new Map<string, Promise<unknown>>();
const failedAt = new Map<string, number>();
const RETRY_MS = 60_000;

/** What the card service says about a card,
 *  declared in schema.ts and called as any app calls a service. It reads
 *  the providers, so the provider never sees who reads the page. */
function ask(embed: Embed): Promise<unknown> {
  const key = embed.provider === "youtube" ? `video ${embed.video_id}` : `post ${embed.post_id}`;
  const held = asked.get(key);
  if (held) return held;
  const failed = failedAt.get(key);
  if (failed !== undefined && Date.now() - failed < RETRY_MS) return Promise.resolve(null);
  const reading = app.cards.call("read", { url: embed.url }).catch(() => null).then((answer) => {
    if (answer === null || answer === undefined) {
      asked.delete(key);
      failedAt.set(key, Date.now());
    } else {
      failedAt.delete(key);
    }
    return answer;
  });
  asked.set(key, reading);
  return reading;
}

/** What a card's brick says about it: a video's title and channel; a post's
 *  author, words, date and pictures — checked as a stored card is. Null when
 *  there is nothing to keep yet (no answer, the brick or the provider busy):
 *  the card is asked about again another time. An answer that the video or
 *  post is gone is kept as read. */
export function readEmbedDetails(embed: Embed): Promise<Embed | null> {
  return ask(embed).then((answer) => withCardAnswer(embed, answer));
}

/** Pictures on screen, by address: their object URL, read once however
 *  many cards show them, and let go with the last. */
const pictures = new Map<string, { views: number; reading: Promise<string | null> }>();

/** The bytes the web service's `image` answered, as a Blob — or null for
 *  anything but a picture. */
function pictureOf(answer: { status: number; contentType: string; bodyBase64: string | null }): Blob | null {
  if (answer.status !== 200 || !answer.bodyBase64 || !/^image\//i.test(answer.contentType)) return null;
  const binary = atob(answer.bodyBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: answer.contentType });
}

/** A picture from the web — a video's still, a post's picture — as bytes
 *  through the web service: an app page cannot load another origin's
 *  picture, and should not: the site would see every reader. Its URL is
 *  null when it cannot be had; `release` lets it go. */
export async function publicPicture(url: string): Promise<{ url: string | null; release(): void }> {
  let held = pictures.get(url);
  if (!held) {
    const entry = {
      views: 0,
      reading: app.web.request("image", { url })
        .then((answer) => {
          const picture = pictureOf(answer);
          return picture ? URL.createObjectURL(picture) : null;
        })
        .catch(() => null),
    };
    pictures.set(url, entry);
    held = entry;
  }
  const entry = held;
  entry.views += 1;
  const shown = await entry.reading;
  // A picture that could not be had is asked again by the next card.
  if (shown === null && pictures.get(url) === entry) pictures.delete(url);
  let released = false;
  return {
    url: shown,
    release() {
      if (released) return;
      released = true;
      entry.views -= 1;
      if (entry.views > 0) return;
      if (pictures.get(url) === entry) pictures.delete(url);
      if (shown) URL.revokeObjectURL(shown);
    },
  };
}
