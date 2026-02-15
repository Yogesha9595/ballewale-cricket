export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/run") {
        return await runAutomation(env);
      }

      if (url.pathname === "/api/live.json") {
        return await getLiveScores(env, ctx);
      }

      return new Response("BalleWale Worker running.");
    } catch (err) {
      return new Response("Worker Error: " + err.toString(), {
        status: 500
      });
    }
  }
};

////////////////////////////////////////////////////////
// LIVE SCORE API (STABLE VERSION)
////////////////////////////////////////////////////////
async function getLiveScores(env, ctx) {
  const cache = caches.default;
  const cacheKey = new Request("https://cache/live-score-single");

  // 1️⃣ Serve cached data first (prevents empty flashes)
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  try {
    const res = await fetch(
      `https://api.cricapi.com/v1/currentMatches?apikey=${env.CRICKET_API_KEY}&offset=0`
    );

    const json = await res.json();
    const matches = json?.data || [];

    if (!matches.length) {
      return jsonResponse({ matches: [] }, 15);
    }

    // 2️⃣ Prefer India / Pakistan match
    let match =
      matches.find(m =>
        (m.teams || []).some(t =>
          /india|pakistan/i.test(t)
        )
      ) || matches[0];

    const normalized = {
      team1: match.teams?.[0] || "Team A",
      team2: match.teams?.[1] || "Team B",
      score1: match.score?.[0]
        ? `${match.score[0].r}/${match.score[0].w}`
        : "-",
      score2: match.score?.[1]
        ? `${match.score[1].r}/${match.score[1].w}`
        : "-",
      overs: match.score?.[0]?.o ? `${match.score[0].o} ov` : "",
      status: match.status || "Live",
    };

    const response = jsonResponse({ matches: [normalized] }, 20);
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;

  } catch (err) {
    return jsonResponse({ matches: [] }, 10);
  }
}


////////////////////////////////////////////////////////
// MAIN AUTOMATION
////////////////////////////////////////////////////////
async function runAutomation(env) {
  try {
    const feedUrl =
      "https://www.espncricinfo.com/rss/content/story/feeds/0.xml";
    const res = await fetch(feedUrl);
    const xml = await res.text();

    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 3);

    if (!items.length) {
      return new Response("No RSS items found");
    }

    let created = 0;

    for (const match of items) {
      const item = match[1];
      const title = getTag(item, "title");
      const description = getTag(item, "description");
      const rssImage = extractImageFromRSS(item);

      if (!title) continue;

      const slug = generateShortSlug(title);
      const category = detectCategory(title);
      const seo = generateSEO(title);

      const article = await generateArticle(env, title, description);
      if (!article) continue;

      const image = await getSafeFeaturedImage(
        env,
        title,
        category,
        rssImage
      );

      const video = getYouTubeEmbed(category);

      const pushed = await pushToGitHub(
        env,
        slug,
        title,
        article,
        seo,
        category,
        image,
        video
      );

      if (pushed) created++;
    }

    return new Response(`Automation complete. Posts created: ${created}`);
  } catch (err) {
    return new Response("Automation error: " + err.toString());
  }
}

////////////////////////////////////////////////////////
// IMAGE WORKFLOW
////////////////////////////////////////////////////////
async function getSafeFeaturedImage(env, title, category, rssImage) {
  // 1. RSS image
  if (rssImage && (await isValidImage(rssImage))) {
    return rssImage;
  }

  // 2. Unsplash image
  const unsplash = await getUnsplashImage(env, title);
  if (unsplash && (await isValidImage(unsplash))) {
    return unsplash;
  }

  // 3. Category fallback
  return getFeaturedImage(category);
}

async function getUnsplashImage(env, query) {
  try {
    const res = await fetch(
      `https://api.unsplash.com/photos/random?query=${encodeURIComponent(
        query + " cricket"
      )}&orientation=landscape`,
      {
        headers: {
          Authorization: `Client-ID ${env.UNSPLASH_KEY}`
        }
      }
    );

    const data = await res.json();
    return data.urls?.regular || null;
  } catch {
    return null;
  }
}

async function isValidImage(url) {
  try {
    const res = await fetch(url, { method: "HEAD" });
    return res.ok && res.headers.get("content-type")?.includes("image");
  } catch {
    return false;
  }
}

function extractImageFromRSS(item) {
  const match = item.match(/<media:content[^>]+url="([^"]+)"/);
  return match ? match[1] : null;
}

////////////////////////////////////////////////////////
// ARTICLE GENERATION
////////////////////////////////////////////////////////
async function generateArticle(env, title, description) {
  try {
    const response = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: "You are a professional cricket journalist."
            },
            {
              role: "user",
              content: `Write a 600-word SEO optimized cricket news article.
Use subheadings.
Make it engaging.

Title: ${title}
Context: ${description}`
            }
          ],
          temperature: 0.4
        })
      }
    );

    const data = await response.json();
    return data.choices?.[0]?.message?.content || null;
  } catch {
    return null;
  }
}

////////////////////////////////////////////////////////
// GITHUB PUSH
////////////////////////////////////////////////////////
async function pushToGitHub(
  env,
  slug,
  title,
  article,
  seo,
  category,
  image,
  video
) {
  const filePath = `content/posts/${slug}.md`;

  const content = `---
title: "${seo.seoTitle}"
date: ${new Date().toISOString()}
draft: false
description: "${seo.description}"
categories: ["${category}"]
tags: ["${category}", "Cricket News"]
image: "${image}"
---

${article}

## Watch Related Coverage
<iframe width="100%" height="400" src="${video}" frameborder="0" allowfullscreen></iframe>
`;

  const encoded = btoa(unescape(encodeURIComponent(content)));

  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${filePath}`;

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `token ${env.GITHUB_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "cloudflare-worker"
    },
    body: JSON.stringify({
      message: `Auto cricket post: ${title}`,
      content: encoded,
      branch: "main"
    })
  });

  const result = await response.json();

  if (result.message && result.message.includes("already exists")) {
    return false;
  }

  return true;
}

////////////////////////////////////////////////////////
// HELPERS
////////////////////////////////////////////////////////
function getTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match
    ? match[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim()
    : "";
}

function generateShortSlug(title) {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(" ");

  const stop = ["the", "a", "an", "of", "in", "on", "for", "to", "with", "and"];

  return words
    .filter(w => w && !stop.includes(w))
    .slice(0, 5)
    .join("-");
}

function generateSEO(title) {
  return {
    seoTitle: `${title} | BalleWale`,
    description: `${title} – Latest cricket updates and match insights.`
  };
}

function detectCategory(title) {
  const t = title.toLowerCase();
  if (t.includes("ipl")) return "IPL";
  if (t.includes("india")) return "India";
  if (t.includes("world cup")) return "World Cup";
  return "Cricket";
}

function getFeaturedImage(category) {
  const images = {
    IPL: "https://images.unsplash.com/photo-1587280501635-68a0e82cd5ff?w=1600&q=80",
    India:
      "https://images.unsplash.com/photo-1546519638-68e109498ffc?w=1600&q=80",
    "World Cup":
      "https://images.unsplash.com/photo-1508098682722-e99c43a406b2?w=1600&q=80",
    Cricket:
      "https://images.unsplash.com/photo-1531415074968-036ba1b575da?w=1600&q=80"
  };

  return images[category] || images.Cricket;
}

function getYouTubeEmbed(category) {
  const videos = {
    IPL: "https://www.youtube.com/embed/VV3W1yQ9YxE",
    India: "https://www.youtube.com/embed/7K6y0c7C9f8",
    "World Cup": "https://www.youtube.com/embed/p8g9T0e9D5Q",
    Cricket: "https://www.youtube.com/embed/5qap5aO4i9A"
  };

  return videos[category] || videos.Cricket;
}
