// update-prices.js
// Run by GitHub Actions. Finds finished matches for our tracked teams on a
// given date, pulls each tracked player's rating/goals/assists from
// API-Football, applies the position-weighted pricing formula, and writes
// the new price into Firestore.

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const API_KEY = process.env.API_FOOTBALL_KEY;
const SERVICE_ACCOUNT_JSON = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
const TARGET_DATE = process.env.TARGET_DATE || new Date().toISOString().slice(0, 10);

if (!API_KEY) throw new Error('Missing API_FOOTBALL_KEY secret');
if (!SERVICE_ACCOUNT_JSON) throw new Error('Missing FIREBASE_SERVICE_ACCOUNT_JSON secret');

const serviceAccount = JSON.parse(SERVICE_ACCOUNT_JSON);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const PLAYERS = JSON.parse(fs.readFileSync(path.join(__dirname, 'players.json'), 'utf8'));
const TRACKED_TEAMS = [...new Set(PLAYERS.map(p => p.team))];

// ---- Position-weighted pricing formula ----
const WEIGHTS = {
  GK: { rating: 1.0, cleanSheet: 2.0, goalConceded: -0.4 },
  DEF: { rating: 0.9, cleanSheet: 1.2, goal: 2.5, assist: 1.5 },
  MID: { rating: 0.7, goal: 2.0, assist: 1.8 },
  FWD: { rating: 0.5, goal: 1.8, assist: 1.2 }
};
const MAX_MOVE_FRACTION = 0.25; // dampen: no single gameweek move exceeds ±25%

function normalizeName(str) {
  return String(str)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

async function apiFootballFetch(endpoint) {
  const res = await fetch(`https://v3.football.api-sports.io${endpoint}`, {
    headers: { 'x-apisports-key': API_KEY }
  });
  if (!res.ok) throw new Error(`API-Football request failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return json.response;
}

async function findFixturesForDate(date) {
  const fixtures = await apiFootballFetch(`/fixtures?date=${date}`);
  return fixtures.filter(fx => {
    const home = fx.teams.home.name;
    const away = fx.teams.away.name;
    const finished = fx.fixture.status.short === 'FT' || fx.fixture.status.short === 'AET' || fx.fixture.status.short === 'PEN';
    const involvesTracked = TRACKED_TEAMS.includes(home) || TRACKED_TEAMS.includes(away);
    return finished && involvesTracked;
  });
}

async function getFixturePlayerStats(fixtureId) {
  return await apiFootballFetch(`/fixtures/players?fixture=${fixtureId}`);
}

function computePriceMove(position, rating, goals, assists, minutesPlayed, cleanSheet, goalsConceded) {
  const w = WEIGHTS[position];
  if (!w) return 0;
  let bonus = 0;
  if (position === 'GK') {
    bonus = (cleanSheet ? w.cleanSheet : 0) + (goalsConceded || 0) * w.goalConceded;
  } else if (position === 'DEF') {
    bonus = (cleanSheet ? w.cleanSheet : 0) + (goals || 0) * w.goal + (assists || 0) * w.assist;
  } else {
    bonus = (goals || 0) * w.goal + (assists || 0) * w.assist;
  }
  const ratingComponent = w.rating * ((rating || 6.5) - 6.5);
  const minutesScale = Math.min(1, (minutesPlayed || 0) / 90);
  return (ratingComponent + bonus) * minutesScale;
}

async function run() {
  console.log(`Checking fixtures for ${TARGET_DATE} involving: ${TRACKED_TEAMS.join(', ')}`);
  const fixtures = await findFixturesForDate(TARGET_DATE);

  if (fixtures.length === 0) {
    console.log('No finished matches found for tracked teams on this date. Nothing to update.');
    return;
  }

  for (const fixture of fixtures) {
    const fixtureId = fixture.fixture.id;
    const homeGoals = fixture.goals.home;
    const awayGoals = fixture.goals.away;
    console.log(`Processing fixture ${fixtureId}: ${fixture.teams.home.name} ${homeGoals}-${awayGoals} ${fixture.teams.away.name}`);

    const teamStats = await getFixturePlayerStats(fixtureId);

    for (const teamBlock of teamStats) {
      const teamName = teamBlock.team.name;
      const isHome = teamName === fixture.teams.home.name;
      const goalsConcededByThisTeam = isHome ? awayGoals : homeGoals;
      const cleanSheet = goalsConcededByThisTeam === 0;

      for (const entry of teamBlock.players) {
        const apiName = entry.player.name;
        const match = PLAYERS.find(p => normalizeName(p.name) === normalizeName(apiName));
        if (!match) continue;

        const stats = entry.statistics && entry.statistics[0];
        if (!stats || stats.games.minutes == null) {
          console.log(`  ${match.name}: did not play, skipping`);
          continue;
        }

        const rating = parseFloat(stats.games.rating) || 6.5;
        const goals = stats.goals.total || 0;
        const assists = stats.goals.assists || 0;
        const minutes = stats.games.minutes || 0;

        const move = computePriceMove(match.position, rating, goals, assists, minutes, cleanSheet, goalsConcededByThisTeam);

        const playerRef = db.collection('players').doc(match.id);
        await db.runTransaction(async (tx) => {
          const doc = await tx.get(playerRef);
          const data = doc.data() || {};
          const currentPrice = Number(data.Price || data.price || 10);
          const cappedMove = Math.max(-currentPrice * MAX_MOVE_FRACTION, Math.min(currentPrice * MAX_MOVE_FRACTION, move));
          const newPrice = Math.max(1, Math.round((currentPrice + cappedMove) * 10) / 10);

          const history = Array.isArray(data.priceHistory) ? data.priceHistory : [currentPrice];
          history.push(newPrice);
          if (history.length > 10) history.shift();

          tx.set(playerRef, { Price: newPrice, priceHistory: history }, { merge: true });
        });

        console.log(`  ${match.name} (${match.position}): rating ${rating}, ${goals}g ${assists}a, minutes ${minutes}, cleanSheet ${cleanSheet} -> price move ${move.toFixed(2)}`);
      }
    }
  }

  console.log('Done.');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
