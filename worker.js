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

      return new Response("BalleWale Worker Running", {
        headers: { "Content-Type": "text/plain" }
      });
    } catch (err) {
      return new Response("Worker Error: " + err.toString(), {
        status: 500
      });
    }
  }
};

////////////////////////////////////////////////////////
// LIVE SCORE API
////////////////////////////////////////////////////////
async function getLiveScores(env, ctx) {
  const cache = caches.default;
  const cacheKey = new Request("https://cache/live-scores");

  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  try {
    const apiRes = await fetch(
      `https://api.cricapi.com/v1/currentMatches?apikey=${env.CRICKET_API_KEY}`
    );
    const data = await apiRes.json();

    const matches = (data.data || []).slice(0, 5).map(match => ({
      team1: match.teams?.[0] || "",
      team2: match.teams?.[1] || "",
      score1: match.score?.[0]
        ? `${match.score[0].r}/${match.score[0].w}`
        : "-",
      score2: match.score?.[1]
        ? `${match.score[1].r}/${match.score[1].w}`
        : "-",
      status: match.status || "LIVE"
    }));

    const response = jsonResponse({ matches }, 20);
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;

  } catch {
    return jsonResponse({ matches: [] }, 20);
  }
}

////////////////////////////////////////////////////////
// AUTOMATION
////////////////////////////////////////////////////////
async function runAutomation(env) {
  try {
    const feedUrl = "https://www.espncricinfo.com/rss/content/story/feeds/0.xml";
    const res = await fetch(feedUrl);
    const xml = await res.text();

    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 3);
    let created = 0;

    for (const match of items) {
      const item = match[1];
      const title = getTag(item, "title");
      const description = getTag(item, "description");
      const rssImage = extractImageFromRSS(item);

      if (!title) continue;

      const slug = generateSlug(title);

      if (await postExists(env, slug)) continue;

      const article = await generateArticle(env, title, description);
      if (!article) continue;

      const image = await getSafeImage(env, title, rssImage);

      const pushed = await pushToGitHub(
        env,
        slug,
        title,
        article,
        description,
        image
      );

      if (pushed) created++;
    }

    return new Response(`Automation complete. Posts created: ${created}`);
  } catch (err) {
    return new Response("Automation error: " + err.toString(), { status: 500 });
  }
}

////////////////////////////////////////////////////////
// IMAGE PIPELINE
////////////////////////////////////////////////////////
async function getSafeImage(env, title, rssImage) {
  if (rssImage && await isValidImage(rssImage)) {
    return rssImage;
  }

  const unsplash = await getUnsplashImage(env, title);
  if (unsplash && await isValidImage(unsplash)) {
    return unsplash;
  }

  return getCategoryFallback(title);
}

async function getUnsplashImage(env, query) {
  try {
    const res = await fetch(
      `https://api.unsplash.com/photos/random?query=${encodeURIComponent(query)}&orientation=landscape`,
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

function extractImageFromRSS(item) {
  const match = item.match(/<media:content[^>]+url="([^"]+)"/);
  return match ? match[1] : null;
}

async function isValidImage(url) {
  try {
    const res = await fetch(url, { method: "HEAD" });
    return res.ok && res.headers.get("content-type")?.includes("image");
  } catch {
    return false;
  }
}

function getCategoryFallback(title) {
  const t = title.toLowerCase();

  if (t.includes("ipl"))
    return "https://images.unsplash.com/photo-1587280501635-68a0e82cd5ff?w=1600&q=80";
  if (t.includes("india"))
    return "https://images.unsplash.com/photo-1546519638-68e109498ffc?w=1600&q=80";
  if (t.includes("world cup"))
    return "https://images.unsplash.com/photo-1508098682722-e99c43a406b2?w=1600&q=80";

  return "https://images.unsplash.com/photo-1531415074968-036ba1b575da?w=1600&q=80";
}

////////////////////////////////////////////////////////
// AI ARTICLE
////////////////////////////////////////////////////////
async function generateArticle(env, title, description) {
  const prompt = `
Write a 650-word SEO optimized cricket news article.
Use short paragraphs and subheadings.
Make it suitable for Google Discover.

Title: ${title}
Context: ${description}
`;

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.4
      })
    });

    const data = await response.json();
    return data.choices?.[0]?.message?.content || null;

  } catch {
    return null;
  }
}

////////////////////////////////////////////////////////
// GITHUB PUSH
////////////////////////////////////////////////////////
async function pushToGitHub(env, slug, title, article, description, image) {
  const filePath = `content/posts/${slug}.md`;

  const content = `---
title: "${title}"
date: ${new Date().toISOString()}
draft: false
description: "${description}"
categories: ["Cricket"]
tags: ["Cricket News"]
image: "${image}"
---

${article}
`;

  const encoded = btoa(unescape(encodeURIComponent(content)));
  const url = `https://api.github.com/repos/${env.REPO}/contents/${filePath}`;

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "Authorization": `token ${env.GITHUB_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "cloudflare-worker"
    },
    body: JSON.stringify({
      message: `Auto cricket post: ${title}`,
      content: encoded,
      branch: "main"
    })
  });

  const result = await res.json();
  if (result.message && result.message.includes("already exists")) return false;

  return true;
}

////////////////////////////////////////////////////////
// HELPERS
////////////////////////////////////////////////////////
function generateSlug(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(" ")
    .slice(0, 6)
    .join("-");
}

async function postExists(env, slug) {
  const url = `https://api.github.com/repos/${env.REPO}/contents/content/posts/${slug}.md`;

  const res = await fetch(url, {
    headers: {
      "Authorization": `token ${env.GITHUB_TOKEN}`,
      "User-Agent": "cloudflare-worker"
    }
  });

  return res.status === 200;
}

function getTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? match[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim() : "";
}

function jsonResponse(data, cacheSeconds = 30) {
  return new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${cacheSeconds}`
    }
  });
}
