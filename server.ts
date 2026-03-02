import express from 'express';
import { createServer as createViteServer } from 'vite';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { createClient } from '@supabase/supabase-js';
import { Role, Player, getQuestConfig, assignRoles } from './src/utils/gameLogic';

const PORT = 3000;

// Initialize Supabase Admin Client
const supabaseUrl = process.env.VITE_SUPABASE_URL || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

let supabase: any = null;
try {
  if (supabaseUrl && supabaseServiceKey) {
    supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });
  }
} catch (err) {
  console.warn('Failed to initialize Supabase admin client:', err);
}

async function updatePlayerStats(userId: string, isWinner: boolean) {
  if (!userId || !supabase) return;

  try {
    // We use an RPC call if we had one, but for simplicity we'll do a select then update
    // In a production app with high concurrency, an RPC function in Postgres is safer
    const { data: profile, error: fetchError } = await supabase
      .from('profiles')
      .select('wins, losses, total_games')
      .eq('id', userId)
      .single();

    if (fetchError) {
      console.error('Error fetching profile for stats update:', fetchError);
      return;
    }

    if (profile) {
      const updates = {
        total_games: (profile.total_games || 0) + 1,
        wins: isWinner ? (profile.wins || 0) + 1 : profile.wins,
        losses: !isWinner ? (profile.losses || 0) + 1 : profile.losses,
      };

      const { error: updateError } = await supabase
        .from('profiles')
        .update(updates)
        .eq('id', userId);

      if (updateError) {
        console.error('Error updating profile stats:', updateError);
      }
    }
  } catch (err) {
    console.error('Failed to update player stats:', err);
  }
}

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: '*',
    },
  });

  // API routes FIRST
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  // Socket.io logic
  setupSocket(io);

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static('dist'));
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

// --- Game Logic ---



interface Quest {
  teamSize: number;
  requiresTwoFails: boolean;
  status: 'pending' | 'success' | 'fail';
  team: string[]; // sessionIds
  votes: Record<string, boolean>; // sessionId -> success(true)/fail(false)
}

interface TeamVoteHistory {
  questIndex: number;
  voteTrack: number;
  leaderIndex: number;
  proposedTeam: string[];
  votes: Record<string, boolean>;
  approved: boolean;
}

interface BotMemory {
  trustScores: Record<string, number>; // sessionId -> score (0-100)
  knownRoles: Record<string, Role | 'Good' | 'Evil'>; // sessionId -> known role/alignment
}

interface Room {
  id: string;
  players: Player[];
  status: 'lobby' | 'role_reveal' | 'team_building' | 'team_voting' | 'team_vote_reveal' | 'quest_voting' | 'assassin' | 'game_over';
  settings: {
    optionalRoles: Role[];
  };
  gameState: {
    quests: Quest[];
    currentQuestIndex: number;
    voteTrack: number; // 0-5
    leaderIndex: number;
    proposedTeam: string[]; // sessionIds
    teamVotes: Record<string, boolean>; // sessionId -> approve(true)/reject(false)
    winner: 'good' | 'evil' | null;
    assassinationTarget: string | null;
    voteHistory: TeamVoteHistory[];
    botMemories: Record<string, BotMemory>; // bot sessionId -> memory
  };
  lastActivityTime: number;
  idleWarningEmitted: boolean;
}

const IDLE_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes
const IDLE_WARNING_COUNTDOWN_S = 30; // 30 seconds after warning

function touchRoom(room: Room) {
  room.lastActivityTime = Date.now();
  room.idleWarningEmitted = false;
}

const rooms: Record<string, Room> = {};

// === SECURITY: Socket identity mapping ===
// Maps socket.id → sessionId so we never trust client-sent sessionId
const socketToSession: Record<string, string> = {};

// === SECURITY: Sanitize room data before broadcasting ===
// Strips other players' roles and botMemories, but respects Avalon's role visibility rules:
// - Merlin sees evil (except Mordred)
// - Percival sees Merlin and Morgana
// - Evil (except Oberon) sees fellow evil (except Oberon)
function sanitizeRoomForPlayer(room: Room, viewerSessionId: string): Room {
  // During game_over, reveal all roles
  if (room.status === 'game_over') {
    const { botMemories, ...safeGameState } = room.gameState as any;
    return { ...room, gameState: safeGameState };
  }

  const viewer = room.players.find(p => p.sessionId === viewerSessionId);
  const viewerRole = viewer?.role as string | null;
  const isViewerEvil = viewerRole ? ['Assassin', 'Morgana', 'Mordred', 'Minion'].includes(viewerRole) : false;

  const sanitizedPlayers = room.players.map(p => {
    if (p.sessionId === viewerSessionId) {
      return p; // Player always sees their own role
    }

    const targetRole = p.role as string | null;
    if (!targetRole) return { ...p, role: null };

    const isTargetEvil = ['Assassin', 'Morgana', 'Mordred', 'Minion', 'Oberon'].includes(targetRole);

    // Merlin sees all evil EXCEPT Mordred
    if (viewerRole === 'Merlin' && isTargetEvil && targetRole !== 'Mordred') {
      return p;
    }

    // Percival sees Merlin and Morgana (doesn't know which is which — UI only shows names)
    if (viewerRole === 'Percival' && (targetRole === 'Merlin' || targetRole === 'Morgana')) {
      return p;
    }

    // Evil (except Oberon) sees fellow evil (except Oberon)
    if (isViewerEvil && ['Assassin', 'Morgana', 'Mordred', 'Minion'].includes(targetRole)) {
      return p;
    }

    return { ...p, role: null }; // Hide role from this viewer
  });

  const { botMemories, ...safeGameState } = room.gameState as any;
  return {
    ...room,
    players: sanitizedPlayers,
    gameState: safeGameState,
  };
}

// Broadcast a personalized, sanitized room update to each connected player
function broadcastRoom(room: Room, io: Server) {
  room.players.forEach(player => {
    if (player.id && !player.isBot) {
      const sanitized = sanitizeRoomForPlayer(room, player.sessionId);
      io.to(player.id).emit('room_update', sanitized);
    }
  });
}

function initializeBotMemories(room: Room) {
  room.players.filter(p => p.isBot).forEach(bot => {
    const memory: BotMemory = {
      trustScores: {},
      knownRoles: {}
    };

    room.players.forEach(p => {
      if (p.sessionId === bot.sessionId) {
        memory.trustScores[p.sessionId] = 100; // Trust self completely
        memory.knownRoles[p.sessionId] = bot.role as Role;
        return;
      }

      // Default trust is 50
      memory.trustScores[p.sessionId] = 50;

      const botRole = bot.role as Role;
      const targetRole = p.role as Role;
      const isBotEvil = ['Assassin', 'Morgana', 'Mordred', 'Minion', 'Oberon'].includes(botRole);
      const isTargetEvil = ['Assassin', 'Morgana', 'Mordred', 'Minion', 'Oberon'].includes(targetRole);

      if (botRole === 'Merlin') {
        // Merlin knows all evil except Mordred
        if (isTargetEvil && targetRole !== 'Mordred') {
          memory.trustScores[p.sessionId] = 0;
          memory.knownRoles[p.sessionId] = 'Evil';
        } else {
          memory.trustScores[p.sessionId] = 70; // Lean towards trusting others
        }
      } else if (botRole === 'Percival') {
        // Percival knows Merlin and Morgana but not which is which
        if (targetRole === 'Merlin' || targetRole === 'Morgana') {
          memory.trustScores[p.sessionId] = 60; // Slightly higher trust, needs observation
          // We don't set knownRoles because we don't know alignment yet
        }
      } else if (isBotEvil && botRole !== 'Oberon') {
        // Evil knows other evil (except Oberon)
        if (isTargetEvil && targetRole !== 'Oberon') {
          memory.trustScores[p.sessionId] = 100;
          memory.knownRoles[p.sessionId] = 'Evil';
        } else {
          memory.trustScores[p.sessionId] = 0; // Distrust all good players
          memory.knownRoles[p.sessionId] = 'Good';
        }
      }
    });

    room.gameState.botMemories[bot.sessionId] = memory;
  });
}

function checkTeamVotes(room: Room, io: Server) {
  if (Object.keys(room.gameState.teamVotes).length === room.players.length) {
    const approves = Object.values(room.gameState.teamVotes).filter(v => v).length;
    const rejects = room.players.length - approves;
    const approved = approves > rejects;

    room.gameState.voteHistory.push({
      questIndex: room.gameState.currentQuestIndex,
      voteTrack: room.gameState.voteTrack,
      leaderIndex: room.gameState.leaderIndex,
      proposedTeam: [...room.gameState.proposedTeam],
      votes: { ...room.gameState.teamVotes },
      approved
    });

    room.status = 'team_vote_reveal';
    broadcastRoom(room, io);
    handleBotActions(room, io);
  } else {
    // Just update that someone voted
    broadcastRoom(room, io);
  }
}

function applyTeamVoteResult(room: Room, io: Server) {
  const lastVote = room.gameState.voteHistory[room.gameState.voteHistory.length - 1];
  if (lastVote.approved) {
    // Team approved
    room.status = 'quest_voting';
    room.gameState.quests[room.gameState.currentQuestIndex].team = room.gameState.proposedTeam;
    room.gameState.voteTrack = 0;
  } else {
    // Team rejected
    room.gameState.voteTrack++;
    if (room.gameState.voteTrack >= 5) {
      room.status = 'game_over';
      room.gameState.winner = 'evil';
      recordGameStats(room);
    } else {
      room.status = 'team_building';
      room.gameState.leaderIndex = (room.gameState.leaderIndex + 1) % room.players.length;
      room.gameState.proposedTeam = [];
    }
  }
  broadcastRoom(room, io);
  handleBotActions(room, io);
}

function recordGameStats(room: Room) {
  if (!room.gameState.winner) return;

  room.players.forEach(player => {
    if (player.isBot || !player.userId) return;

    const isEvil = ['Assassin', 'Morgana', 'Mordred', 'Minion', 'Oberon'].includes(player.role as string);
    const isWinner = (room.gameState.winner === 'evil' && isEvil) || (room.gameState.winner === 'good' && !isEvil);

    updatePlayerStats(player.userId, isWinner);
  });
}

function checkQuestVotes(room: Room, io: Server) {
  const quest = room.gameState.quests[room.gameState.currentQuestIndex];
  if (Object.keys(quest.votes).length === quest.teamSize) {
    const fails = Object.values(quest.votes).filter(v => !v).length;
    const failed = quest.requiresTwoFails ? fails >= 2 : fails >= 1;

    quest.status = failed ? 'fail' : 'success';

    // Update bot memories based on quest result
    room.players.filter(p => p.isBot).forEach(bot => {
      const memory = room.gameState.botMemories[bot.sessionId];
      const isBotEvil = ['Assassin', 'Morgana', 'Mordred', 'Minion', 'Oberon'].includes(bot.role as string);

      if (!isBotEvil) {
        // Good bots learn from quest results
        quest.team.forEach(memberId => {
          if (memberId !== bot.sessionId) {
            if (failed) {
              // If quest failed, trust in team members drops significantly
              // If it's a 2-person team and I'm on it, the other person MUST be evil
              if (quest.teamSize === 2 && quest.team.includes(bot.sessionId)) {
                memory.trustScores[memberId] = 0;
                memory.knownRoles[memberId] = 'Evil';
              } else {
                memory.trustScores[memberId] = Math.max(0, (memory.trustScores[memberId] || 50) - 30);
              }
            } else {
              // If quest succeeded, trust in team members increases slightly
              memory.trustScores[memberId] = Math.min(100, (memory.trustScores[memberId] || 50) + 15);
            }
          }
        });
      } else {
        // Evil bots learn who acts like Merlin
        // If a good player rejected a team that had evil on it, they might be Merlin
        const lastVote = room.gameState.voteHistory[room.gameState.voteHistory.length - 1];
        if (lastVote) {
          const teamHadEvil = lastVote.proposedTeam.some(id => memory.knownRoles[id] === 'Evil');
          if (teamHadEvil) {
            room.players.forEach(p => {
              if (memory.knownRoles[p.sessionId] !== 'Evil' && lastVote.votes[p.sessionId] === false) {
                // This good player rejected a team with evil. They might be Merlin.
                // Lower their trust score (from evil's perspective, lower trust = more likely Merlin)
                memory.trustScores[p.sessionId] = Math.max(0, (memory.trustScores[p.sessionId] || 50) - 10);
              }
            });
          }
        }
      }
    });

    const successes = room.gameState.quests.filter(q => q.status === 'success').length;
    const totalFails = room.gameState.quests.filter(q => q.status === 'fail').length;

    if (successes >= 3) {
      room.status = 'assassin';
    } else if (totalFails >= 3) {
      room.status = 'game_over';
      room.gameState.winner = 'evil';
      recordGameStats(room);
    } else {
      room.gameState.currentQuestIndex++;
      room.status = 'team_building';
      room.gameState.leaderIndex = (room.gameState.leaderIndex + 1) % room.players.length;
      room.gameState.proposedTeam = [];
      room.gameState.teamVotes = {};
    }
    broadcastRoom(room, io);
    handleBotActions(room, io);
  } else {
    broadcastRoom(room, io);
  }
}

function handleBotActions(room: Room, io: Server) {
  if (room.status === 'team_building') {
    const leader = room.players[room.gameState.leaderIndex];
    if (leader.isBot) {
      setTimeout(() => {
        if (room.status !== 'team_building') return;
        const currentQuest = room.gameState.quests[room.gameState.currentQuestIndex];
        const memory = room.gameState.botMemories[leader.sessionId];

        // Sort players by trust score descending
        const sortedPlayers = [...room.players].sort((a, b) => {
          return (memory.trustScores[b.sessionId] || 50) - (memory.trustScores[a.sessionId] || 50);
        });

        const isEvil = ['Assassin', 'Morgana', 'Mordred', 'Minion', 'Oberon'].includes(leader.role as string);
        let team: string[] = [];

        if (isEvil) {
          // Evil logic: Include self, maybe one other evil, rest good (to blend in)
          team.push(leader.sessionId);
          const otherEvil = sortedPlayers.filter(p => p.sessionId !== leader.sessionId && memory.knownRoles[p.sessionId] === 'Evil');
          const goodPlayers = sortedPlayers.filter(p => memory.knownRoles[p.sessionId] === 'Good');

          // Randomly decide if we want to bring another evil (if team size > 2)
          if (currentQuest.teamSize > 2 && otherEvil.length > 0 && Math.random() > 0.5) {
            team.push(otherEvil[0].sessionId);
          }

          // Fill the rest with good players (lowest trust from evil perspective = most good)
          const remainingSlots = currentQuest.teamSize - team.length;
          const goodToBring = goodPlayers.slice(0, remainingSlots).map(p => p.sessionId);
          team.push(...goodToBring);

          // If we still need more (e.g., not enough known good), just pick random remaining
          if (team.length < currentQuest.teamSize) {
            const remaining = sortedPlayers.filter(p => !team.includes(p.sessionId)).map(p => p.sessionId);
            team.push(...remaining.slice(0, currentQuest.teamSize - team.length));
          }

        } else if (leader.role === 'Merlin') {
          // Merlin logic: Pick trusted players, but occasionally bait with an evil player on early quests
          team = sortedPlayers.slice(0, currentQuest.teamSize).map(p => p.sessionId);

          // Always include self
          if (!team.includes(leader.sessionId)) {
            team[currentQuest.teamSize - 1] = leader.sessionId;
          }

          // Baiting: On quest 1 or 2, 30% chance to include exactly one known evil player to hide identity
          if (room.gameState.currentQuestIndex < 2 && Math.random() < 0.3) {
            const knownEvil = room.players.filter(p => memory.knownRoles[p.sessionId] === 'Evil');
            if (knownEvil.length > 0) {
              // Replace the least trusted good player in the team (excluding self) with a random evil player
              const evilToBait = knownEvil[Math.floor(Math.random() * knownEvil.length)].sessionId;
              const nonMerlinTeamMembers = team.filter(id => id !== leader.sessionId);
              if (nonMerlinTeamMembers.length > 0) {
                const playerToReplace = nonMerlinTeamMembers[nonMerlinTeamMembers.length - 1]; // Last one is least trusted
                team[team.indexOf(playerToReplace)] = evilToBait;
              }
            }
          }
        } else {
          // Good logic (non-Merlin): Pick the most trusted players
          team = sortedPlayers.slice(0, currentQuest.teamSize).map(p => p.sessionId);
          // Always include self if good
          if (!team.includes(leader.sessionId)) {
            team[currentQuest.teamSize - 1] = leader.sessionId;
          }
        }

        room.gameState.proposedTeam = team;
        room.status = 'team_voting';
        room.gameState.teamVotes = {};
        broadcastRoom(room, io);
        handleBotActions(room, io);
      }, 2000);
    }
  } else if (room.status === 'team_voting') {
    const unvotedBots = room.players.filter(p => p.isBot && !(p.sessionId in room.gameState.teamVotes));
    if (unvotedBots.length > 0) {
      setTimeout(() => {
        if (room.status !== 'team_voting') return;
        unvotedBots.forEach(bot => {
          const memory = room.gameState.botMemories[bot.sessionId];
          const isEvil = ['Assassin', 'Morgana', 'Mordred', 'Minion', 'Oberon'].includes(bot.role as string);
          const proposedTeam = room.gameState.proposedTeam;

          let approve = false;

          if (isEvil) {
            // Evil logic: Approve if team has evil, reject if all good (unless it's vote 5)
            const hasEvil = proposedTeam.some(id => memory.knownRoles[id] === 'Evil' || id === bot.sessionId);
            if (hasEvil) {
              approve = true;
            } else if (room.gameState.voteTrack === 4) {
              // Forced to approve on last track to avoid losing
              approve = true;
            } else {
              // Sometimes randomly approve all-good teams to blend in
              approve = Math.random() > 0.8;
            }
          } else if (bot.role === 'Merlin') {
            // Merlin voting logic: Usually reject evil, but occasionally approve to hide identity
            const hasKnownEvil = proposedTeam.some(id => memory.knownRoles[id] === 'Evil');

            if (hasKnownEvil) {
              // Strategic Approval: On early quests, small chance to approve a team with evil
              if (room.gameState.currentQuestIndex < 2 && Math.random() < 0.15) {
                approve = true;
              } else if (room.gameState.voteTrack === 4) {
                // Forced to approve on last track to avoid losing
                approve = true;
              } else {
                approve = false;
              }
            } else {
              // If no known evil, approve
              approve = true;
            }
          } else {
            // Good logic (non-Merlin): Approve if average trust is high enough, reject if any known evil
            const hasKnownEvil = proposedTeam.some(id => memory.knownRoles[id] === 'Evil');
            if (hasKnownEvil) {
              approve = false;
            } else {
              const avgTrust = proposedTeam.reduce((sum, id) => sum + (memory.trustScores[id] || 50), 0) / proposedTeam.length;
              // Higher threshold if not on the team
              const threshold = proposedTeam.includes(bot.sessionId) ? 45 : 60;
              approve = avgTrust >= threshold;

              // If it's the last vote track, good players might be forced to approve if trust isn't terrible
              if (room.gameState.voteTrack === 4 && avgTrust > 30) {
                approve = true;
              }
            }
          }

          room.gameState.teamVotes[bot.sessionId] = approve;
        });
        checkTeamVotes(room, io);
      }, 2000);
    }
  } else if (room.status === 'team_vote_reveal') {
    const leader = room.players[room.gameState.leaderIndex];
    if (leader.isBot) {
      setTimeout(() => {
        if (room.status !== 'team_vote_reveal') return;
        applyTeamVoteResult(room, io);
      }, 5000);
    }
  } else if (room.status === 'quest_voting') {
    const currentQuest = room.gameState.quests[room.gameState.currentQuestIndex];
    const unvotedBots = room.players.filter(p => p.isBot && room.gameState.proposedTeam.includes(p.sessionId) && !(p.sessionId in currentQuest.votes));
    if (unvotedBots.length > 0) {
      setTimeout(() => {
        if (room.status !== 'quest_voting') return;

        // Coordinate evil votes to avoid double fails if possible
        const evilBotsOnTeam = unvotedBots.filter(p => ['Assassin', 'Morgana', 'Mordred', 'Minion', 'Oberon'].includes(p.role as string));

        unvotedBots.forEach(bot => {
          const isEvil = ['Assassin', 'Morgana', 'Mordred', 'Minion', 'Oberon'].includes(bot.role as string);
          if (isEvil) {
            // If multiple evil bots, maybe only one fails to hide numbers
            if (evilBotsOnTeam.length > 1 && !currentQuest.requiresTwoFails) {
              // Simple coordination: first evil bot in list fails, others succeed
              if (bot.sessionId === evilBotsOnTeam[0].sessionId) {
                currentQuest.votes[bot.sessionId] = false;
              } else {
                currentQuest.votes[bot.sessionId] = true;
              }
            } else {
              // Single evil bot or requires two fails: usually fail, but sometimes succeed on quest 1 to build trust
              if (room.gameState.currentQuestIndex === 0 && Math.random() > 0.5) {
                currentQuest.votes[bot.sessionId] = true;
              } else {
                currentQuest.votes[bot.sessionId] = false;
              }
            }
          } else {
            currentQuest.votes[bot.sessionId] = true; // Good always succeeds
          }
        });
        checkQuestVotes(room, io);
      }, 2000);
    }
  } else if (room.status === 'assassin') {
    const assassin = room.players.find(p => p.role === 'Assassin');
    const evilPlayers = room.players.filter(p => ['Assassin', 'Morgana', 'Mordred', 'Minion', 'Oberon'].includes(p.role as string));
    const hasHumanEvil = evilPlayers.some(p => !p.isBot);

    if (assassin?.isBot && !hasHumanEvil && !room.gameState.assassinationTarget) {
      setTimeout(() => {
        if (room.status !== 'assassin') return;

        const memory = room.gameState.botMemories[assassin.sessionId];
        const goodPlayers = room.players.filter(p => !['Assassin', 'Morgana', 'Mordred', 'Minion', 'Oberon'].includes(p.role as string));

        // Assassin logic: Find the good player with the lowest trust score (meaning they acted most like Merlin)
        // Merlin tends to reject teams with evil, lowering their trust from evil's perspective
        let target = goodPlayers[0];
        let lowestTrust = 100;

        goodPlayers.forEach(p => {
          const trust = memory.trustScores[p.sessionId] || 50;
          if (trust < lowestTrust) {
            lowestTrust = trust;
            target = p;
          }
        });

        room.gameState.assassinationTarget = target.sessionId;
        room.gameState.winner = target.role === 'Merlin' ? 'evil' : 'good';
        room.status = 'game_over';
        recordGameStats(room);
        broadcastRoom(room, io);
      }, 3000);
    }
  }
}

function setupSocket(io: Server) {
  // Periodic idle room checker (runs every 60 seconds)
  setInterval(() => {
    const now = Date.now();
    for (const roomId in rooms) {
      const room = rooms[roomId];
      const elapsed = now - room.lastActivityTime;

      if (elapsed >= IDLE_TIMEOUT_MS + IDLE_WARNING_COUNTDOWN_S * 1000) {
        // Time's up — auto-close
        console.log(`Room ${roomId} auto-closed due to inactivity.`);
        io.to(roomId).emit('game_ended', { reason: 'idle_timeout' });
        delete rooms[roomId];
      } else if (elapsed >= IDLE_TIMEOUT_MS && !room.idleWarningEmitted) {
        // Emit warning
        room.idleWarningEmitted = true;
        io.to(roomId).emit('room_idle_warning', { countdown: IDLE_WARNING_COUNTDOWN_S });
        console.log(`Room ${roomId}: idle warning emitted.`);
      }
    }
  }, 10_000); // Check every 10 seconds for responsiveness

  io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);

    socket.on('join_room', async ({ roomId, sessionId, name, token }) => {
      try {
        socket.join(roomId);

        // SECURITY: Register socket → session mapping
        socketToSession[socket.id] = sessionId;

        let userId: string | undefined;

        // Verify Supabase token if provided
        if (token && supabase) {
          try {
            const { data: { user }, error } = await supabase.auth.getUser(token);
            if (!error && user) {
              userId = user.id;
            }
          } catch (err) {
            console.error('Token verification failed:', err);
          }
        }

        if (!rooms[roomId]) {
          rooms[roomId] = {
            id: roomId,
            players: [],
            status: 'lobby',
            settings: { optionalRoles: [] },
            gameState: {
              quests: [],
              currentQuestIndex: 0,
              voteTrack: 0,
              leaderIndex: 0,
              proposedTeam: [],
              teamVotes: {},
              winner: null,
              assassinationTarget: null,
              voteHistory: [],
              botMemories: {}
            },
            lastActivityTime: Date.now(),
            idleWarningEmitted: false
          };
        }

        const room = rooms[roomId];
        const existingPlayer = room.players.find(p => p.sessionId === sessionId);

        if (existingPlayer) {
          existingPlayer.id = socket.id;
          existingPlayer.name = name;
          existingPlayer.isConnected = true;
          if (userId) existingPlayer.userId = userId;
        } else {
          if (room.status !== 'lobby') {
            socket.emit('error', { message: 'Game already started' });
            return;
          }
          room.players.push({
            id: socket.id,
            sessionId,
            userId,
            name,
            role: null,
            isConnected: true
          });
        }

        touchRoom(room);
        broadcastRoom(room, io);
      } catch (err) {
        console.error('Error in join_room:', err);
        socket.emit('error', { message: 'Failed to join room' });
      }
    });

    socket.on('update_settings', ({ roomId, settings }) => {
      try {
        const room = rooms[roomId];
        if (room && room.status === 'lobby') {
          room.settings = settings;
          touchRoom(room);
          broadcastRoom(room, io);
        }
      } catch (err) {
        console.error('Error in update_settings:', err);
      }
    });

    socket.on('add_bot', ({ roomId }) => {
      try {
        const room = rooms[roomId];
        if (room && room.status === 'lobby' && room.players.length < 10) {
          const botId = 'bot_' + Math.random().toString(36).substring(2, 9);
          room.players.push({
            id: botId,
            sessionId: botId,
            name: 'Bot ' + (room.players.length),
            role: null,
            isConnected: true,
            isBot: true
          });
          touchRoom(room);
          broadcastRoom(room, io);
        }
      } catch (err) {
        console.error('Error in add_bot:', err);
      }
    });

    socket.on('start_game', ({ roomId, requestedRoles }) => {
      try {
        const room = rooms[roomId];
        if (room && room.status === 'lobby' && room.players.length >= 5 && room.players.length <= 10) {
          touchRoom(room);
          assignRoles(room.players, room.settings.optionalRoles, requestedRoles);

          const config = getQuestConfig(room.players.length);
          room.gameState.quests = config.sizes.map((size, i) => ({
            teamSize: size,
            requiresTwoFails: config.twoFails[i],
            status: 'pending',
            team: [],
            votes: {}
          }));
          room.gameState.voteHistory = [];

          room.gameState.leaderIndex = Math.floor(Math.random() * room.players.length);
          room.status = 'role_reveal';
          initializeBotMemories(room);
          broadcastRoom(room, io);
          handleBotActions(room, io);
        }
      } catch (err) {
        console.error('Error in start_game:', err);
      }
    });

    socket.on('ready_team_building', ({ roomId }) => {
      try {
        const room = rooms[roomId];
        if (room && room.status === 'role_reveal') {
          touchRoom(room);
          room.status = 'team_building';
          broadcastRoom(room, io);
          handleBotActions(room, io);
        }
      } catch (err) {
        console.error('Error in ready_team_building:', err);
      }
    });

    socket.on('propose_team', ({ roomId, team }) => {
      try {
        const room = rooms[roomId];
        if (room && room.status === 'team_building') {
          touchRoom(room);
          room.gameState.proposedTeam = team;
          room.status = 'team_voting';
          room.gameState.teamVotes = {};
          broadcastRoom(room, io);
          handleBotActions(room, io);
        }
      } catch (err) {
        console.error('Error in propose_team:', err);
      }
    });

    socket.on('vote_team', ({ roomId, approve }) => {
      try {
        // SECURITY: Use server-side identity, ignore client-sent sessionId
        const sessionId = socketToSession[socket.id];
        if (!sessionId) return;
        const room = rooms[roomId];
        if (room && room.status === 'team_voting') {
          touchRoom(room);
          room.gameState.teamVotes[sessionId] = approve;
          checkTeamVotes(room, io);
        }
      } catch (err) {
        console.error('Error in vote_team:', err);
      }
    });

    socket.on('continue_vote_reveal', ({ roomId }) => {
      try {
        const room = rooms[roomId];
        if (room && room.status === 'team_vote_reveal') {
          touchRoom(room);
          applyTeamVoteResult(room, io);
        }
      } catch (err) {
        console.error('Error in continue_vote_reveal:', err);
      }
    });

    socket.on('vote_quest', ({ roomId, success }) => {
      try {
        // SECURITY: Use server-side identity, ignore client-sent sessionId
        const sessionId = socketToSession[socket.id];
        if (!sessionId) return;
        const room = rooms[roomId];
        if (room && room.status === 'quest_voting') {
          touchRoom(room);
          const quest = room.gameState.quests[room.gameState.currentQuestIndex];
          quest.votes[sessionId] = success;
          checkQuestVotes(room, io);
        }
      } catch (err) {
        console.error('Error in vote_quest:', err);
      }
    });

    socket.on('assassinate', ({ roomId, targetSessionId }) => {
      try {
        // SECURITY: Use server-side identity, ignore client-sent sessionId
        const sessionId = socketToSession[socket.id];
        if (!sessionId) return;
        const room = rooms[roomId];
        if (room && room.status === 'assassin') {
          touchRoom(room);
          const sender = room.players.find(p => p.sessionId === sessionId);
          const assassin = room.players.find(p => p.role === 'Assassin');
          const isEvil = sender && ['Assassin', 'Morgana', 'Mordred', 'Minion', 'Oberon'].includes(sender.role as string);

          const canAssassinate = sender?.role === 'Assassin' || (isEvil && assassin?.isBot);

          if (canAssassinate) {
            room.gameState.assassinationTarget = targetSessionId;
            const target = room.players.find(p => p.sessionId === targetSessionId);

            if (target && target.role === 'Merlin') {
              room.gameState.winner = 'evil';
            } else {
              room.gameState.winner = 'good';
            }
            room.status = 'game_over';
            recordGameStats(room);
            broadcastRoom(room, io);
          }
        }
      } catch (err) {
        console.error('Error in assassinate:', err);
      }
    });

    socket.on('leave_room', ({ roomId }) => {
      try {
        // SECURITY: Use server-side identity
        const sessionId = socketToSession[socket.id];
        if (!sessionId) return;
        const room = rooms[roomId];
        if (room) {
          // Remove player from room
          room.players = room.players.filter(p => p.sessionId !== sessionId);

          if (room.players.length === 0) {
            // Clean up empty room
            delete rooms[roomId];
          } else {
            // Notify remaining players
            broadcastRoom(room, io);
          }
        }
        socket.leave(roomId);
      } catch (err) {
        console.error('Error in leave_room:', err);
      }
    });

    socket.on('kick_player', ({ roomId, targetSessionId }) => {
      try {
        const room = rooms[roomId];
        if (room) {
          const sender = room.players.find(p => p.id === socket.id);
          if (sender && room.players[0]?.sessionId === sender.sessionId) {
            const targetPlayer = room.players.find(p => p.sessionId === targetSessionId);
            if (targetPlayer) {
              room.players = room.players.filter(p => p.sessionId !== targetSessionId);
              if (targetPlayer.id) {
                io.to(targetPlayer.id).emit('kicked');
              }
              broadcastRoom(room, io);
            }
          }
        }
      } catch (err) {
        console.error('Error in kick_player:', err);
      }
    });

    socket.on('end_game', ({ roomId }) => {
      try {
        const room = rooms[roomId];
        if (room) {
          const sender = room.players.find(p => p.id === socket.id);
          if (sender && room.players[0]?.sessionId === sender.sessionId) {
            io.to(roomId).emit('game_ended');
            delete rooms[roomId];
          }
        }
      } catch (err) {
        console.error('Error in end_game:', err);
      }
    });

    socket.on('restart_game', ({ roomId }) => {
      try {
        const room = rooms[roomId];
        if (room && room.status === 'game_over') {
          // Only host can restart
          const sender = room.players.find(p => p.id === socket.id);
          if (sender && room.players[0]?.sessionId === sender.sessionId) {
            // Remove bots, keep human players
            room.players = room.players.filter(p => !p.isBot);
            // Reset all player roles
            room.players.forEach(p => { p.role = null; });
            // Reset room to lobby
            room.status = 'lobby';
            room.gameState = {
              quests: [],
              currentQuestIndex: 0,
              voteTrack: 0,
              leaderIndex: 0,
              proposedTeam: [],
              teamVotes: {},
              winner: null,
              assassinationTarget: null,
              voteHistory: [],
              botMemories: {}
            };
            broadcastRoom(room, io);
          }
        }
      } catch (err) {
        console.error('Error in restart_game:', err);
      }
    });

    socket.on('room_activity_ping', ({ roomId }) => {
      try {
        const room = rooms[roomId];
        if (room) {
          touchRoom(room);
          // Notify all clients that idle warning is cancelled
          io.to(roomId).emit('room_idle_cancelled');
        }
      } catch (err) {
        console.error('Error in room_activity_ping:', err);
      }
    });

    socket.on('disconnect', () => {
      try {
        // SECURITY: Clean up socket → session mapping
        delete socketToSession[socket.id];
        // Find player and mark as disconnected
        for (const roomId in rooms) {
          const room = rooms[roomId];
          const player = room.players.find(p => p.id === socket.id);
          if (player) {
            player.isConnected = false;
            broadcastRoom(room, io);
          }
        }
      } catch (err) {
        console.error('Error in disconnect:', err);
      }
    });
  });
}

startServer();
