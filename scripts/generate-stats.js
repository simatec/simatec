#!/usr/bin/env node
/**
 * Erzeugt eine eigene, selbst gestaltete GitHub-Stats-SVG-Karte
 * ohne Abhängigkeit von einem externen Dienst.
 *
 * Benötigt: GITHUB_TOKEN (in Actions automatisch vorhanden) und GITHUB_USERNAME.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const USERNAME = process.env.GITHUB_USERNAME;
const TOKEN = process.env.GITHUB_TOKEN;
const OUTPUT_PATH = process.env.OUTPUT_PATH || 'stats.svg';

if (!USERNAME || !TOKEN) {
  console.error('GITHUB_USERNAME und GITHUB_TOKEN müssen gesetzt sein.');
  process.exit(1);
}

function graphql(query, variables) {
  const payload = JSON.stringify({ query, variables });
  const options = {
    hostname: 'api.github.com',
    path: '/graphql',
    method: 'POST',
    headers: {
      Authorization: `bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'github-stats-card',
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`GitHub API Fehler ${res.statusCode}: ${data}`));
          return;
        }
        try {
          const json = JSON.parse(data);
          if (json.errors) {
            reject(new Error(JSON.stringify(json.errors)));
            return;
          }
          resolve(json.data);
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Ruft die npm-Downloadzahlen des letzten Monats für ein Paket ab.
// Gibt null zurück, wenn kein npm-Paket mit diesem Namen existiert
// (z. B. bei Repos, die nicht als npm-Paket veröffentlicht sind).
function fetchNpmDownloads(packageName) {
  const options = {
    hostname: 'api.npmjs.org',
    path: `/downloads/point/last-month/${encodeURIComponent(packageName)}`,
    method: 'GET',
    headers: { 'User-Agent': 'github-stats-card' },
  };

  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          resolve(null);
          return;
        }
        try {
          const json = JSON.parse(data);
          resolve(typeof json.downloads === 'number' ? json.downloads : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

const QUERY = `
query ($login: String!) {
  user(login: $login) {
    name
    login
    followers { totalCount }
    repositories(first: 100, ownerAffiliations: OWNER, isFork: false) {
      totalCount
      nodes {
        name
        stargazerCount
        languages(first: 5, orderBy: { field: SIZE, direction: DESC }) {
          edges {
            size
            node { name color }
          }
        }
      }
    }
    contributionsCollection {
      contributionCalendar {
        totalContributions
      }
    }
  }
}
`;

function aggregateLanguages(repositories) {
  const totals = new Map();
  let grandTotal = 0;

  for (const repo of repositories) {
    for (const edge of repo.languages.edges) {
      const name = edge.node.name;
      const size = edge.size;
      grandTotal += size;
      totals.set(name, (totals.get(name) || 0) + size);
    }
  }

  const sorted = [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, size]) => ({
      name,
      pct: grandTotal ? Math.round((size / grandTotal) * 100) : 0,
    }));

  return sorted;
}

function formatCount(n) {
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  }
  return String(n);
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function truncate(str, maxLen) {
  return str.length > maxLen ? `${str.slice(0, maxLen - 1)}…` : str;
}

// Feste Farbpalette pro Sprachbalken-Segment (unabhängig von GitHub-eigenen Farben,
// damit die Karte optisch konsistent im eigenen Design bleibt).
const LANG_COLORS = ['#378ADD', '#EF9F27', '#D85A30'];

function buildSvg(stats) {
  const width = 600;
  const rowHeight = 22;
  const listTop = 208;
  const height = listTop + 24 + stats.topRepos.length * rowHeight + 16;
  const scale = 1.35;
  const displayWidth = Math.round(width * scale);
  const displayHeight = Math.round(height * scale);
  const barX = 24;
  const barWidth = 280;
  const barY = 176;
  const barHeight = 8;
  const starsColX = width - 160;
  const installsColX = width - 24;
  const nameMaxChars = 38;

  let langBars = '';
  let cursor = barX;
  stats.languages.forEach((lang, i) => {
    const segWidth = Math.max(Math.round((lang.pct / 100) * barWidth), 2);
    const color = LANG_COLORS[i % LANG_COLORS.length];
    langBars += `<rect x="${cursor}" y="${barY}" width="${segWidth}" height="${barHeight}" rx="4" fill="${color}"/>`;
    cursor += segWidth;
  });

  const langLabel = stats.languages
    .map((l) => `${escapeXml(l.name)} ${l.pct}%`)
    .join('  ·  ');

  const cards = [
    { label: 'Repos', value: formatCount(stats.repoCount), color: '#1D9E75', bg: '#E1F5EE' },
    { label: 'Sterne', value: formatCount(stats.stars), color: '#534AB7', bg: '#EEEDFE' },
    { label: 'Commits', value: formatCount(stats.contributions), color: '#993C1D', bg: '#FAECE7' },
    { label: 'Follower', value: formatCount(stats.followers), color: '#993556', bg: '#FBEAF0' },
  ];

  const cardWidth = 132;
  const cardHeight = 56;
  const gap = 16;

  let cardMarkup = '';
  cards.forEach((card, i) => {
    const x = 24 + i * (cardWidth + gap);
    cardMarkup += `
      <g transform="translate(${x},80)">
        <rect width="${cardWidth}" height="${cardHeight}" rx="8" fill="${card.bg}"/>
        <text x="12" y="24" font-size="11" fill="${card.color}" font-family="Helvetica, Arial, sans-serif">${card.label}</text>
        <text x="12" y="44" font-size="20" font-weight="600" fill="${card.color}" font-family="Helvetica, Arial, sans-serif">${card.value}</text>
      </g>`;
  });

  let repoRows = '';
  stats.topRepos.forEach((repo, i) => {
    const rowY = listTop + 24 + i * rowHeight;
    const installsLabel = repo.installs === null ? '–' : `${formatCount(repo.installs)}/Monat`;
    repoRows += `
      <text x="24" y="${rowY}" font-size="12" fill="#1a1a1a" font-family="Helvetica, Arial, sans-serif">${escapeXml(truncate(repo.name, nameMaxChars))}</text>
      <text x="${starsColX}" y="${rowY}" font-size="12" fill="#6b6b66" font-family="Helvetica, Arial, sans-serif" text-anchor="end">★ ${formatCount(repo.stars)}</text>
      <text x="${installsColX}" y="${rowY}" font-size="12" fill="#6b6b66" font-family="Helvetica, Arial, sans-serif" text-anchor="end">${installsLabel}</text>`;
    if (i < stats.topRepos.length - 1) {
      repoRows += `<line x1="24" y1="${rowY + 8}" x2="${width - 24}" y2="${rowY + 8}" stroke="#f0f0ec" stroke-width="1"/>`;
    }
  });

  return `<svg width="${displayWidth}" height="${displayHeight}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img">
  <title>GitHub-Stats für ${escapeXml(stats.login)}</title>
  <desc>Repos, Sterne, Commits, Follower, Top-Sprachen und Top-5-Repos mit npm-Installationen</desc>
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="12" fill="#ffffff" stroke="#e5e5e0" stroke-width="1"/>

  <text x="24" y="38" font-size="16" font-weight="600" fill="#1a1a1a" font-family="Helvetica, Arial, sans-serif">${escapeXml(stats.name || stats.login)}</text>
  <text x="24" y="58" font-size="12" fill="#6b6b66" font-family="Helvetica, Arial, sans-serif">@${escapeXml(stats.login)}</text>

  ${cardMarkup}

  <text x="24" y="168" font-size="11" fill="#6b6b66" font-family="Helvetica, Arial, sans-serif">Top Sprachen</text>
  <rect x="${barX}" y="${barY}" width="${barWidth}" height="${barHeight}" rx="4" fill="#eeeeee"/>
  ${langBars}
  <text x="${barX + barWidth + 16}" y="${barY + 6}" font-size="11" fill="#6b6b66" font-family="Helvetica, Arial, sans-serif">${langLabel}</text>

  <line x1="24" y1="${listTop - 8}" x2="${width - 24}" y2="${listTop - 8}" stroke="#e5e5e0" stroke-width="1"/>
  <text x="24" y="${listTop + 8}" font-size="11" fill="#6b6b66" font-family="Helvetica, Arial, sans-serif">Top 5 Repos</text>
  <text x="${starsColX}" y="${listTop + 8}" font-size="11" fill="#6b6b66" font-family="Helvetica, Arial, sans-serif" text-anchor="end">Sterne</text>
  <text x="${installsColX}" y="${listTop + 8}" font-size="11" fill="#6b6b66" font-family="Helvetica, Arial, sans-serif" text-anchor="end">Installationen</text>
  ${repoRows}
</svg>`;
}

async function main() {
  const data = await graphql(QUERY, { login: USERNAME });
  const user = data.user;

  if (!user) {
    throw new Error(`Nutzer ${USERNAME} nicht gefunden.`);
  }

  const repoNodes = user.repositories.nodes;

  // Installationen (npm-Downloads) für ALLE Repos abrufen, damit die
  // Sortierung nach Installationen korrekt ist statt nur eine
  // sternebasierte Vorauswahl zu verfeinern.
  const reposWithInstalls = await Promise.all(
    repoNodes.map(async (repo) => ({
      name: repo.name,
      stars: repo.stargazerCount,
      installs: await fetchNpmDownloads(repo.name.toLowerCase()),
    }))
  );

  const topRepos = [...reposWithInstalls]
    .sort((a, b) => (b.installs ?? -1) - (a.installs ?? -1))
    .slice(0, 5);

  const stats = {
    login: user.login,
    name: user.name,
    followers: user.followers.totalCount,
    repoCount: user.repositories.totalCount,
    stars: repoNodes.reduce((sum, r) => sum + r.stargazerCount, 0),
    contributions: user.contributionsCollection.contributionCalendar.totalContributions,
    languages: aggregateLanguages(repoNodes),
    topRepos,
  };

  const svg = buildSvg(stats);
  const outputFile = path.resolve(process.cwd(), OUTPUT_PATH);
  fs.writeFileSync(outputFile, svg, 'utf8');
  console.log(`Stats-Karte geschrieben nach ${outputFile}`);
  console.log(stats);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
