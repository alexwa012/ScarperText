import axios from "axios";
import Parser from "rss-parser";
import cron from "node-cron";
import admin from "firebase-admin";

// --- Init Firebase Admin ---
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)),
  });
}
const db = admin.firestore();

// --- RSS Feeds ---
const RSS_FEEDS = {
  Health: "https://timesofindia.indiatimes.com/rssfeeds/2886704.cms",
  Technology: "https://timesofindia.indiatimes.com/rssfeeds/66949542.cms",
  Business: "https://timesofindia.indiatimes.com/rssfeeds/1898055.cms",
  "Top Picks": "https://timesofindia.indiatimes.com/rssfeedstopstories.cms",
};

const parser = new Parser();

// --- Check if article already exists ---
async function articleExists(url) {
  const snapshot = await db.collection("articles").where("url", "==", url).limit(1).get();
  return !snapshot.empty;
}

// --- Process one RSS feed ---
async function processFeed(category, feedUrl) {
  try {
    const feed = await parser.parseURL(feedUrl);

    for (const item of feed.items) {
      const exists = await articleExists(item.link);
      if (exists) {
        console.log(`⏩ Skipping already saved: ${item.link}`);
        continue;
      }

      try {
        // 1. Scrape raw text
        const scrapeRes = await axios.post("http://localhost:5000/scrape", { url: item.link });
        const rawText = scrapeRes.data.text;

        // 2. Clean with OpenAI
        const cleanRes = await axios.post("http://localhost:5000/clean", { text: rawText });
        const { title: cleanTitle, description: cleanDescription } = cleanRes.data;

        // 3. Save to Firestore
        await db.collection("articles").add({
          url: item.link,
          category,
          imageUrl: item.enclosure?.url || null,
          title: cleanTitle || item.title,             // ✅ use cleaned if available
          description: cleanDescription || item.contentSnippet || "",
          time: item.pubDate ? new Date(item.pubDate) : new Date(),
          createdAt: new Date(),
        });

        console.log(`✅ Saved cleaned article: ${cleanTitle}`);
      } catch (err) {
        console.error(`❌ Error processing article: ${item.link}`, err.message);
      }
    }
  } catch (err) {
    console.error(`❌ Error fetching feed (${category}):`, err.message);
  }
}

// --- Run all feeds ---
async function runJob() {
  console.log("🚀 Cron job started at", new Date().toISOString());
  for (const [category, url] of Object.entries(RSS_FEEDS)) {
    await processFeed(category, url);
  }
  console.log("🎯 Cron job finished at", new Date().toISOString());
}

// --- Schedule every 2 hours ---
cron.schedule("0 */2 * * *", runJob);

// Run immediately when script starts (optional)
runJob();
