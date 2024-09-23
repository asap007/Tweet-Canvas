require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { createCanvas, loadImage } = require('canvas');
const path = require('path');
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const app = express();
const port = process.env.PORT || 5000;

app.set('trust proxy', 1);

app.use(cors());


// Rate limiting
const limiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour in milliseconds
  max: 10, // limit each IP to 10 requests per windowMs
  message: (req, res) => {
    const timeRemaining = Math.ceil((req.rateLimit.resetTime - Date.now()) / 1000 / 60);
    return {
      error: `You've reached your request limit. Please try again in ${timeRemaining} minutes.`
    };
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  },
});


app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));


const userInfoCache = new Map();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

app.get('/', (req, res) => {
  res.render('index');
});

app.post('/improve', limiter, async (req, res) => {
  const { text } = req.body;

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const prompt = `Improve the following tweet to make it more engaging, humanizing and concise (max 280 characters) directly give the new content & make sure not to give anything other than new version of the tweet content, direclty give the content: "${text}"`;

    const result = await model.generateContent(prompt);
    const improvedText = result.response.text();

    res.json({ improvedText });
  } catch (error) {
    console.error('Error improving text:', error);
    res.status(500).json({ error: 'Failed to improve text' });
  }
});

app.post('/generate', limiter, async (req, res) => {
  const { text, template, option, username } = req.body;
  let userInfo = { name: 'Twitter User', handle: '@twitteruser', profilePicUrl: null };
  console.log("Starting generating....");
  console.log("Received data:", { text, template, option, username });
  
  if (option === 'screenshot' && username) {
    try {
      if (userInfoCache.has(username)) {
        userInfo = userInfoCache.get(username);
        console.log("Using cached user info for:", username);
      } else {
        console.log("Scraping Twitter profile for:", username);
        userInfo = await scrapeTwitterProfileWithRetry(username);
        userInfoCache.set(username, userInfo);
        console.log("Scraped and cached user info:", userInfo);
      }
    } catch (error) {
      console.error('Error scraping Twitter profile:', error);
      userInfo.name = username;
      userInfo.handle = `@${username}`;
    }
  }
  
  try {
    console.log("Generating image with user info:", userInfo);
    const image = await generateImage(text, template, userInfo, option);
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': image.length
    });
    res.end(image);
    console.log("Image generated and sent successfully");
  } catch (error) {
    console.error('Error generating image:', error);
    res.status(500).json({ error: 'Failed to generate image' });
  }
});

async function scrapeTwitterProfileWithRetry(username, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const userInfo = await scrapeTwitterProfile(username);
      if (userInfo.profilePicUrl) {
        return userInfo;
      }
      console.log(`Attempt ${i + 1}: Profile picture URL is undefined. Retrying...`);
    } catch (error) {
      console.error(`Attempt ${i + 1} failed:`, error);
      if (i === maxRetries - 1) {
        throw error;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds before retrying
  }
  throw new Error('Failed to scrape Twitter profile after multiple attempts');
}

async function scrapeTwitterProfile(username) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--disable-setuid-sandbox",
    "--no-sandbox",
    "--single-process",
    "--no-zygote",],
    executablePath:
      process.env.NODE_ENV === "production"
        ? process.env.PUPPETEER_EXECUTABLE_PATH
        : puppeteer.executablePath(),
  });
  const page = await browser.newPage();
  try {
    console.log(`Navigating to https://x.com/${username}`);
    await page.goto(`https://x.com/${username}`, { waitUntil: 'networkidle2', timeout: 60000 });

    // Wait for the profile information to load
    await page.waitForSelector('h2[aria-level="2"]', { timeout: 60000 });

    const content = await page.content();
    const $ = cheerio.load(content);

    const name = $('h2[aria-level="2"]').text().trim();
    const handle = username.startsWith('@') ? username : `@${username}`;

    // Try multiple selectors for the profile picture
    let profilePicUrl = $('img[alt="Profile picture"]').attr('src');
    if (!profilePicUrl) {
      profilePicUrl = $('img[src*="/profile_images/"]').first().attr('src');
    }
    if (profilePicUrl) {
      profilePicUrl = profilePicUrl.replace('_normal', '_200x200');
    }

    console.log("Extracted information:", { name, handle, profilePicUrl });

    return { name, handle, profilePicUrl };
  } catch (error) {
    console.error('Error during scraping:', error);
    throw error;
  } finally {
    await browser.close();
  }
}

async function generateImage(text, template = 'light', userInfo, option) {
  const screenshotThemes = {
    light: { bg: '#FFFFFF', cardBg: '#FFFFFF', text: '#000000', accent: '#1DA1F2' },
    dark: { bg: '#192531', cardBg: '#192734', text: '#FFFFFF', accent: '#1DA1F2' }
  };

  const portraitThemes = {
    light: { bg: '#3498db', text: '#ffffff', accent: '#ffffff', secondary: '#ffffff' },
    dark: { bg: '#2c3e50', text: '#ecf0f1', accent: '#ecf0f1', secondary: '#ecf0f1' }
  };

  if (option === 'screenshot') {
    const colors = screenshotThemes[template] || screenshotThemes.light;
    return generateScreenshotImage(text, colors, userInfo);
  } else {
    const colors = portraitThemes[template] || portraitThemes.light;
    return generatePortraitImage(text, colors);
  }
}

async function generateScreenshotImage(text, colors, userInfo) {
  const width = 600;
  const minHeight = 300;
  const maxHeight = 1200;
  const ctx = createCanvas(width, minHeight).getContext('2d');

  // Calculate text height
  ctx.font = '22px Arial, sans-serif';
  const maxWidth = width - 80;
  const lines = text.split('\n').flatMap(line => getLines(ctx, line, maxWidth));
  const lineHeight = 32;
  const totalTextHeight = lines.length * lineHeight;

  // Calculate total content height (reduced space below text)
  const contentHeight = 120 + totalTextHeight + 60; // Reduced from 100 to 60
  const height = Math.max(minHeight, Math.min(maxHeight, contentHeight));

  // Create the actual canvas with the calculated height
  const canvas = createCanvas(width, height);
  const finalCtx = canvas.getContext('2d');

  // Background
  finalCtx.fillStyle = colors.bg;
  finalCtx.fillRect(0, 0, width, height);

  // Card
  const cardWidth = width - 40;
  const cardHeight = height - 40;
  finalCtx.fillStyle = colors.cardBg;
  roundRect(finalCtx, 20, 20, cardWidth, cardHeight, 16);

  // Profile picture (shifted up)
  const profilePicY = 45;
  if (userInfo.profilePicUrl) {
    try {
      const img = await loadImage(userInfo.profilePicUrl);
      finalCtx.save();
      finalCtx.beginPath();
      finalCtx.arc(60, profilePicY, 30, 0, 2 * Math.PI);
      finalCtx.closePath();
      finalCtx.clip();
      finalCtx.drawImage(img, 30, profilePicY - 30, 60, 60);
      finalCtx.restore();
    } catch (error) {
      console.error('Error loading profile picture:', error);
      finalCtx.fillStyle = colors.accent;
      finalCtx.beginPath();
      finalCtx.arc(60, profilePicY, 30, 0, 2 * Math.PI);
      finalCtx.fill();
    }
  } else {
    finalCtx.fillStyle = colors.accent;
    finalCtx.beginPath();
    finalCtx.arc(60, profilePicY, 30, 0, 2 * Math.PI);
    finalCtx.fill();
  }

  // Username and handle (adjusted positions)
  finalCtx.font = 'bold 22px Arial, sans-serif';
  finalCtx.fillStyle = colors.text;
  finalCtx.fillText(userInfo.name, 110, 35);
  finalCtx.font = '16px Arial, sans-serif';
  finalCtx.fillStyle = colors.text + '80';
  finalCtx.fillText(userInfo.handle, 110, 60);

  // X logo (adjusted position)
  try {
    const logoImg = await loadImage(path.join(__dirname, 'icon.png'));
    finalCtx.drawImage(logoImg, width - 60, 35, 24, 24);
  } catch (error) {
    console.error('Error loading X logo:', error);
    finalCtx.fillStyle = colors.text;
    finalCtx.font = 'bold 24px Arial, sans-serif';
    finalCtx.fillText('𝕏', width - 60, 45);
  }

  // Tweet text (adjusted starting position)
  finalCtx.font = '22px Arial, sans-serif';
  finalCtx.fillStyle = colors.text;
  const startY = 110;

  lines.forEach((line, index) => {
    const words = line.split(' ');
    let currentX = 40;
    words.forEach(word => {
      if (word.startsWith('#') || word.startsWith('@')) {
        finalCtx.fillStyle = colors.accent;
      } else {
        finalCtx.fillStyle = colors.text;
      }
      finalCtx.fillText(word, currentX, startY + index * lineHeight);
      currentX += finalCtx.measureText(word + ' ').width;
    });
  });

  // Time and date (adjusted position)
  const now = new Date();
  const timeString = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const dateString = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  finalCtx.font = '16px Arial, sans-serif';
  finalCtx.fillStyle = colors.text + '80';
  finalCtx.fillText(`${timeString} · ${dateString}`, 40, height - 20); // Moved closer to the bottom

  return canvas.toBuffer('image/png');
}

async function generatePortraitImage(text, colors, userInfo) {
  const width = 600;
  const minHeight = 600; // Minimum height for short content
  const maxHeight = 2000; // Maximum height to prevent excessively tall images
  const ctx = createCanvas(width, 1).getContext('2d'); // Temporary canvas for text measurement

  // Text setup
  ctx.font = 'bold 32px Arial, sans-serif';
  const maxWidth = width - 80;
  const lines = text.split('\n').flatMap(line => getLines(ctx, line, maxWidth));
  const lineHeight = 40;

  // Calculate required height
  const textHeight = lines.length * lineHeight;
  const paddingTop = 200;
  const paddingBottom = 100;
  let height = Math.min(Math.max(minHeight, textHeight + paddingTop + paddingBottom), maxHeight);

  // Create the actual canvas with calculated height
  const canvas = createCanvas(width, height);
  const finalCtx = canvas.getContext('2d');

  // Background - solid vibrant color
  finalCtx.fillStyle = colors.bg;
  finalCtx.fillRect(0, 0, width, height);

  // Text
  finalCtx.font = 'bold 32px Arial, sans-serif';
  finalCtx.fillStyle = colors.text;
  let startY = paddingTop;

  lines.forEach((line, index) => {
    finalCtx.fillText(line, 40, startY + index * lineHeight);
  });

  // X logo
  try {
    const logoImg = await loadImage(path.join(__dirname, 'icon.png'));
    finalCtx.drawImage(logoImg, width / 2 - 20, height - 60, 40, 40);
  } catch (error) {
    console.error('Error loading X logo:', error);
    finalCtx.fillStyle = colors.text;
    finalCtx.font = 'bold 40px Arial, sans-serif';
    finalCtx.fillText('𝕏', width / 2 - 20, height - 30);
  }

  return canvas.toBuffer('image/png');
}


function getLines(ctx, text, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let currentLine = words[0];

  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    const width = ctx.measureText(currentLine + " " + word).width;
    if (width < maxWidth) {
      currentLine += " " + word;
    } else {
      lines.push(currentLine);
      currentLine = word;
    }
  }
  lines.push(currentLine);
  return lines;
}

function roundRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
  ctx.fill();
}

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
