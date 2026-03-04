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

  app.get('/api/rooms', (req, res) => {
    const roomList = Object.values(rooms).map(room => ({
      id: room.id,
      hostName: room.players[0]?.name || 'Unknown',
      playerCount: room.players.length,
      maxPlayers: 10,
      status: room.status === 'lobby' ? 'waiting' : 'in_game',
    }));
    res.json(roomList);
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

type BotDifficulty = 'normal' | 'hard';

interface BotMemory {
  trustScores: Record<string, number>; // sessionId -> score (0-100)
  knownRoles: Record<string, Role | 'Good' | 'Evil'>; // sessionId -> known role/alignment
  merlinSuspicion: Record<string, number>; // sessionId -> score (0-100), used by evil
  failAssociation: Record<string, number>; // sessionId -> number of failed quests they were on
  votePatterns: Record<string, { approvedEvil: number; rejectedEvil: number; totalVotes: number }>;
  percivalCandidates?: { a: string; b: string; merlinLikelihood: Record<string, number> };
}

interface Room {
  id: string;
  players: Player[];
  status: 'lobby' | 'role_reveal' | 'team_building' | 'team_voting' | 'team_vote_reveal' | 'quest_voting' | 'quest_result' | 'assassin' | 'game_over';
  settings: {
    optionalRoles: Role[];
    botDifficulty: BotDifficulty;
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
  const difficulty = room.settings.botDifficulty || 'normal';

  room.players.filter(p => p.isBot).forEach(bot => {
    const memory: BotMemory = {
      trustScores: {},
      knownRoles: {},
      merlinSuspicion: {},
      failAssociation: {},
      votePatterns: {}
    };

    const isBotEvil = ['Assassin', 'Morgana', 'Mordred', 'Minion', 'Oberon'].includes(bot.role as string);
    let merlinCandidateA: string | null = null;
    let merlinCandidateB: string | null = null;

    room.players.forEach(p => {
      memory.failAssociation[p.sessionId] = 0;
      memory.votePatterns[p.sessionId] = { approvedEvil: 0, rejectedEvil: 0, totalVotes: 0 };

      if (isBotEvil) {
        memory.merlinSuspicion[p.sessionId] = 0;
      }

      if (p.sessionId === bot.sessionId) {
        memory.trustScores[p.sessionId] = 100; // Trust self completely
        memory.knownRoles[p.sessionId] = bot.role as Role;
        return;
      }

      // Default trust is 50. In hard mode, good bots start a bit more neutral, evil bots distrust good more.
      memory.trustScores[p.sessionId] = difficulty === 'hard' ? 40 : 50;

      const botRole = bot.role as Role;
      const targetRole = p.role as Role;
      const isTargetEvil = ['Assassin', 'Morgana', 'Mordred', 'Minion', 'Oberon'].includes(targetRole);

      if (botRole === 'Merlin') {
        // Merlin knows all evil except Mordred
        if (isTargetEvil && targetRole !== 'Mordred') {
          memory.trustScores[p.sessionId] = 0;
          memory.knownRoles[p.sessionId] = 'Evil';
        } else {
          memory.trustScores[p.sessionId] = difficulty === 'hard' ? 60 : 70; // Lean towards trusting others
        }
      } else if (botRole === 'Percival') {
        // Percival knows Merlin and Morgana but not which is which
        if (targetRole === 'Merlin' || targetRole === 'Morgana') {
          memory.trustScores[p.sessionId] = difficulty === 'hard' ? 50 : 60;

          if (!merlinCandidateA) merlinCandidateA = p.sessionId;
          else if (!merlinCandidateB) merlinCandidateB = p.sessionId;
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

    if (bot.role === 'Percival' && merlinCandidateA && merlinCandidateB) {
      memory.percivalCandidates = {
        a: merlinCandidateA,
        b: merlinCandidateB,
        merlinLikelihood: {
          [merlinCandidateA]: 50,
          [merlinCandidateB]: 50
        }
      };
    }

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

    // --- Improvement A: Vote History Analysis ---
    // Good bots learn who approves/rejects teams with evil. Evil bots learn who acts like Merlin.
    const difficulty = room.settings.botDifficulty || 'normal';
    const trustDelta = difficulty === 'hard' ? 15 : 5;
    const suspicionDelta = difficulty === 'hard' ? 15 : 5;

    room.players.filter(p => p.isBot).forEach(bot => {
      const memory = room.gameState.botMemories[bot.sessionId];
      const isBotEvil = ['Assassin', 'Morgana', 'Mordred', 'Minion', 'Oberon'].includes(bot.role as string);

      const teamHadKnownEvil = room.gameState.proposedTeam.some(id => memory.knownRoles[id] === 'Evil' || (isBotEvil && id === bot.sessionId));

      room.players.forEach(p => {
        if (p.sessionId === bot.sessionId) return;

        const votedApprove = room.gameState.teamVotes[p.sessionId];

        // Update general vote patterns
        if (teamHadKnownEvil) {
          if (votedApprove) memory.votePatterns[p.sessionId].approvedEvil++;
          else memory.votePatterns[p.sessionId].rejectedEvil++;
        }
        memory.votePatterns[p.sessionId].totalVotes++;

        if (!isBotEvil) {
          // Good Bot Logic: Adjust trust based on voting for evil-tainted teams
          if (teamHadKnownEvil) {
            if (votedApprove) {
              memory.trustScores[p.sessionId] = Math.max(0, (memory.trustScores[p.sessionId] || 50) - trustDelta);
            } else {
              memory.trustScores[p.sessionId] = Math.min(100, (memory.trustScores[p.sessionId] || 50) + trustDelta);
            }
          }
          // Note: We used to penalize players for rejecting teams with no known evil. 
          // This was removed because blind Good bots were penalizing Merlin for dodging hidden evil.
        } else {
          // Evil Bot Logic: Track who is acting like Merlin (rejecting evil teams, approving good teams)
          if (memory.knownRoles[p.sessionId] !== 'Evil') {
            if (teamHadKnownEvil && !votedApprove) {
              // Good player rejected a team with evil -> acts like Merlin
              memory.merlinSuspicion[p.sessionId] = Math.min(100, (memory.merlinSuspicion[p.sessionId] || 0) + suspicionDelta);
            } else if (!teamHadKnownEvil && votedApprove) {
              // Good player approved an all-good team -> acts like Merlin
              memory.merlinSuspicion[p.sessionId] = Math.min(100, (memory.merlinSuspicion[p.sessionId] || 0) + (suspicionDelta / 2));
            } else if (teamHadKnownEvil && votedApprove) {
              // Good player approved team with evil -> less likely Merlin
              memory.merlinSuspicion[p.sessionId] = Math.max(0, (memory.merlinSuspicion[p.sessionId] || 0) - suspicionDelta);
            }
          }
        }

        // Percival Deduction Update
        if (bot.role === 'Percival' && memory.percivalCandidates) {
          const { a, b, merlinLikelihood } = memory.percivalCandidates;
          if (p.sessionId === a || p.sessionId === b) {
            // Percival expects Merlin to reject teams with evil
            if (teamHadKnownEvil && !votedApprove) {
              merlinLikelihood[p.sessionId] = Math.min(100, merlinLikelihood[p.sessionId] + suspicionDelta);
              memory.trustScores[p.sessionId] = Math.min(100, (memory.trustScores[p.sessionId] || 50) + trustDelta);

              // The other candidate is less likely Merlin
              const other = p.sessionId === a ? b : a;
              merlinLikelihood[other] = Math.max(0, merlinLikelihood[other] - suspicionDelta);
              memory.trustScores[other] = Math.max(0, (memory.trustScores[other] || 50) - trustDelta);
            }
          }
        }

      });
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
    const difficulty = room.settings.botDifficulty || 'normal';

    // Track fail association for everyone on the team
    if (failed) {
      quest.team.forEach(memberId => {
        room.players.filter(p => p.isBot).forEach(bot => {
          const memory = room.gameState.botMemories[bot.sessionId];
          memory.failAssociation[memberId]++;
        });
      });
    }

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
                const drop = difficulty === 'hard' ? 40 : 30;
                memory.trustScores[memberId] = Math.max(0, (memory.trustScores[memberId] || 50) - drop);
              }
            } else {
              // If quest succeeded, trust in team members increases slightly
              const boost = difficulty === 'hard' ? 20 : 15;
              memory.trustScores[memberId] = Math.min(100, (memory.trustScores[memberId] || 50) + boost);
            }
          }
        });

        // Good bots ALSO learn from who approved a doomed team vs who rejected it
        const lastVote = room.gameState.voteHistory[room.gameState.voteHistory.length - 1];
        if (lastVote) {
          room.players.forEach(p => {
            if (p.sessionId !== bot.sessionId && !quest.team.includes(p.sessionId)) {
              // Focus on people NOT on the team (we already handled team members above)
              const votedApprove = lastVote.votes[p.sessionId];
              if (failed) {
                // Quest failed. Approvers are suspicious, Rejecters look good (like Merlin).
                if (votedApprove) {
                  memory.trustScores[p.sessionId] = Math.max(0, (memory.trustScores[p.sessionId] || 50) - 15);
                } else {
                  memory.trustScores[p.sessionId] = Math.min(100, (memory.trustScores[p.sessionId] || 50) + 15);
                }
              } else {
                // Quest succeeded. Approvers look good. 
                if (votedApprove) {
                  memory.trustScores[p.sessionId] = Math.min(100, (memory.trustScores[p.sessionId] || 50) + 10);
                }
              }
            }
          });
        }

        // Percival deduction on quest ends
        if (bot.role === 'Percival' && memory.percivalCandidates) {
          const { a, b, merlinLikelihood } = memory.percivalCandidates;

          const shift = difficulty === 'hard' ? 40 : 20;

          // 1. Evaluate the Proposer of the Quest
          const leaderId = room.gameState.voteHistory[room.gameState.voteHistory.length - 1]?.leaderIndex;
          if (leaderId !== undefined) {
            const proposer = room.players[leaderId].sessionId;
            if (proposer === a || proposer === b) {
              const other = proposer === a ? b : a;
              if (failed) {
                // A candidate proposed a failing team. They are almost certainly Morgana.
                merlinLikelihood[proposer] = 0;
                merlinLikelihood[other] = 100;
                memory.trustScores[proposer] = 0;
                memory.trustScores[other] = 100;
              } else if (difficulty === 'hard') {
                // A candidate proposed a succeeding team. Slightly more likely to be Merlin.
                merlinLikelihood[proposer] = Math.min(100, merlinLikelihood[proposer] + 15);
                merlinLikelihood[other] = Math.max(0, merlinLikelihood[other] - 15);
              }
            }
          }

          // 2. Evaluate Candidate Votes on the Final Team
          if (lastVote) {
            const aApproved = lastVote.votes[a];
            const bApproved = lastVote.votes[b];

            if (aApproved !== bApproved) {
              const approver = aApproved ? a : b;
              const rejecter = aApproved ? b : a;

              if (failed) {
                // Approver of a doomed team is likely Morgana. Rejecter is Merlin.
                merlinLikelihood[approver] = Math.max(0, merlinLikelihood[approver] - shift);
                merlinLikelihood[rejecter] = Math.min(100, merlinLikelihood[rejecter] + shift);
                memory.trustScores[approver] = Math.max(0, (memory.trustScores[approver] || 50) - shift);
                memory.trustScores[rejecter] = Math.min(100, (memory.trustScores[rejecter] || 50) + shift);
              } else if (difficulty === 'hard') {
                // If it succeeded, approver is slightly more likely Merlin
                merlinLikelihood[approver] = Math.min(100, merlinLikelihood[approver] + 10);
                merlinLikelihood[rejecter] = Math.max(0, merlinLikelihood[rejecter] - 10);
              }
            }
          }

          // 3. Evaluate Team Participation
          const aOnTeam = quest.team.includes(a);
          const bOnTeam = quest.team.includes(b);

          if (aOnTeam !== bOnTeam) {
            const candidate = aOnTeam ? a : b;
            const other = aOnTeam ? b : a;

            if (failed) {
              // Participant on failed team is likely Morgana
              merlinLikelihood[candidate] = Math.max(0, merlinLikelihood[candidate] - shift);
              merlinLikelihood[other] = Math.min(100, merlinLikelihood[other] + shift);

              memory.trustScores[candidate] = Math.max(0, (memory.trustScores[candidate] || 50) - shift);
              memory.trustScores[other] = Math.min(100, (memory.trustScores[other] || 50) + shift);
            } else if (difficulty === 'hard') {
              // Participant on succeeding team is somewhat more likely Merlin
              merlinLikelihood[candidate] = Math.min(100, merlinLikelihood[candidate] + 10);
              merlinLikelihood[other] = Math.max(0, merlinLikelihood[other] - 10);
            }
          }
        }
      } else {
        // Evil bots learn who acts like Merlin
        // If a good player rejected a team that had evil on it and the quest FAILED, 
        // they were right, and thus more likely Merlin.
        if (failed) {
          const lastVote = room.gameState.voteHistory[room.gameState.voteHistory.length - 1];
          if (lastVote) {
            room.players.forEach(p => {
              if (memory.knownRoles[p.sessionId] !== 'Evil' && lastVote.votes[p.sessionId] === false) {
                const suspicionBoost = difficulty === 'hard' ? 20 : 10;
                memory.merlinSuspicion[p.sessionId] = Math.min(100, (memory.merlinSuspicion[p.sessionId] || 0) + suspicionBoost);
              }
            });
          }
        }
      }
    });

    // Enter quest_result phase to show result before advancing
    room.status = 'quest_result';
    broadcastRoom(room, io);
    handleBotActions(room, io);
  } else {
    broadcastRoom(room, io);
  }
}

// Advance from quest_result to the next phase
function applyQuestResult(room: Room, io: Server) {
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
}

function handleBotActions(room: Room, io: Server) {
  if (room.status === 'team_building') {
    const leader = room.players[room.gameState.leaderIndex];
    if (leader.isBot) {
      setTimeout(() => {
        if (room.status !== 'team_building') return;
        const currentQuest = room.gameState.quests[room.gameState.currentQuestIndex];
        const memory = room.gameState.botMemories[leader.sessionId];

        const difficulty = room.settings.botDifficulty || 'normal';

        // Sort players by trust score descending, but also penalize for failAssociation
        const sortedPlayers = [...room.players].sort((a, b) => {
          const penaltyA = (memory.failAssociation[a.sessionId] || 0) * (difficulty === 'hard' ? 25 : 15);
          const penaltyB = (memory.failAssociation[b.sessionId] || 0) * (difficulty === 'hard' ? 25 : 15);
          const trustA = (memory.trustScores[a.sessionId] || 50) - penaltyA;
          const trustB = (memory.trustScores[b.sessionId] || 50) - penaltyB;
          return trustB - trustA;
        });

        const isEvil = ['Assassin', 'Morgana', 'Mordred', 'Minion', 'Oberon'].includes(leader.role as string);
        let team: string[] = [];

        if (isEvil) {
          // --- Improvement B: Strategic Evil Team Building (Hard Mode) ---
          if (difficulty === 'hard') {
            const failsNeeded = 3 - room.gameState.quests.filter(q => q.status === 'fail').length;
            const requiresTwo = currentQuest.requiresTwoFails;

            if (failsNeeded === 1 && requiresTwo) {
              // Must get TWO evil players on the team to win
              team.push(leader.sessionId);
              const otherEvil = room.players.filter(p => p.sessionId !== leader.sessionId && memory.knownRoles[p.sessionId] === 'Evil');
              if (otherEvil.length > 0) {
                team.push(otherEvil[0].sessionId);
              }
            } else if (room.gameState.currentQuestIndex === 0 && Math.random() < 0.3) {
              // Occasional strategic bluff: Propose an all-good team on Quest 1 to build trust
              const goodPlayers = sortedPlayers.filter(p => memory.knownRoles[p.sessionId] === 'Good');
              team.push(...goodPlayers.slice(0, currentQuest.teamSize).map(p => p.sessionId));
            } else {
              // Standard evil: Include self, maybe one other evil if team size > 2
              team.push(leader.sessionId);
              const otherEvil = sortedPlayers.filter(p => p.sessionId !== leader.sessionId && memory.knownRoles[p.sessionId] === 'Evil');
              if (currentQuest.teamSize > 2 && otherEvil.length > 0 && Math.random() > 0.4) {
                team.push(otherEvil[0].sessionId);
              }
            }
          } else {
            // Evil logic (Normal): Include self, maybe one other evil, rest good (to blend in)
            team.push(leader.sessionId);
            const otherEvil = sortedPlayers.filter(p => p.sessionId !== leader.sessionId && memory.knownRoles[p.sessionId] === 'Evil');

            // Randomly decide if we want to bring another evil (if team size > 2)
            if (currentQuest.teamSize > 2 && otherEvil.length > 0 && Math.random() > 0.5) {
              team.push(otherEvil[0].sessionId);
            }
          }

          // Fill the rest with good players (lowest trust from evil perspective = most good)
          // Exclude self if already included
          const goodPlayers = sortedPlayers.filter(p => memory.knownRoles[p.sessionId] === 'Good');
          const remainingSlots = currentQuest.teamSize - team.length;
          const goodToBring = goodPlayers.slice(0, remainingSlots).map(p => p.sessionId);
          team.push(...goodToBring);

          // If we still need more (e.g., not enough known good), just pick random remaining
          if (team.length < currentQuest.teamSize) {
            const remaining = sortedPlayers.filter(p => !team.includes(p.sessionId)).map(p => p.sessionId);
            team.push(...remaining.slice(0, currentQuest.teamSize - team.length));
          }

        } else if (leader.role === 'Merlin') {
          // Merlin logic: Pick trusted players (which for Merlin is just the Good players)
          team = sortedPlayers.slice(0, currentQuest.teamSize).map(p => p.sessionId);

          // Always include self
          if (!team.includes(leader.sessionId)) {
            team[currentQuest.teamSize - 1] = leader.sessionId;
          }

          // Baiting: On early quests, chance to include exactly one known evil player to hide identity
          // Hard mode does this slightly more effectively, avoiding players with high failAssociation
          const baitChance = difficulty === 'hard' ? 0.4 : 0.3;
          if (room.gameState.currentQuestIndex < 2 && Math.random() < baitChance) {
            const knownEvil = room.players.filter(p => memory.knownRoles[p.sessionId] === 'Evil' && memory.failAssociation[p.sessionId] === 0);
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
          const difficulty = room.settings.botDifficulty || 'normal';

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
            let hasKnownEvil = proposedTeam.some(id => memory.knownRoles[id] === 'Evil');

            // --- Improvement: Percival uses their knowledge ---
            if (bot.role === 'Percival' && memory.percivalCandidates && difficulty === 'hard') {
              const { a, b, merlinLikelihood } = memory.percivalCandidates;
              if (merlinLikelihood[a] >= 65 && proposedTeam.includes(b)) hasKnownEvil = true; // b is Morgana
              if (merlinLikelihood[b] >= 65 && proposedTeam.includes(a)) hasKnownEvil = true; // a is Morgana
            }

            if (hasKnownEvil) {
              approve = false;
            } else {
              const avgTrust = proposedTeam.reduce((sum, id) => sum + (memory.trustScores[id] || 50), 0) / proposedTeam.length;

              let threshold = proposedTeam.includes(bot.sessionId) ? 45 : (room.gameState.currentQuestIndex < 2 ? 50 : 55);

              if (difficulty === 'hard') {
                // Hard Good bots are fiercely skeptical of people who fail quests
                const hasSuspicious = proposedTeam.some(id => (memory.failAssociation[id] || 0) > 0);
                if (hasSuspicious) {
                  threshold += 15; // Strictly reject teams containing failed quest members
                }
                // Hard Good bots don't blindly approve Round 1 teams they aren't on giving leader free pass
                if (!proposedTeam.includes(bot.sessionId) && room.gameState.currentQuestIndex === 0) {
                  threshold = 52; // Forces average trust to be > 50, requiring they've earned trust.
                }
              }

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
        const difficulty = room.settings.botDifficulty || 'normal';

        unvotedBots.forEach(bot => {
          const isEvil = ['Assassin', 'Morgana', 'Mordred', 'Minion', 'Oberon'].includes(bot.role as string);
          if (isEvil) {
            // --- Improvement E: Strategic Evil Play (Hard mode) ---
            if (difficulty === 'hard') {
              const totalFailsSoFar = room.gameState.quests.filter(q => q.status === 'fail').length;

              // If we already have 2 fails, we MUST fail this to win
              if (totalFailsSoFar === 2) {
                currentQuest.votes[bot.sessionId] = false;
              }
              // If it's quest 1 and team size 2, maybe succeed to build trust
              else if (room.gameState.currentQuestIndex === 0 && currentQuest.teamSize === 2 && Math.random() < 0.5) {
                currentQuest.votes[bot.sessionId] = true;
              }
              // If multiple evil on team and requiresTwoFails, BOTH must fail
              else if (evilBotsOnTeam.length >= 2 && currentQuest.requiresTwoFails) {
                // Make sure the first *two* evil bots fail it
                const evilIndex = evilBotsOnTeam.findIndex(p => p.sessionId === bot.sessionId);
                if (evilIndex < 2) {
                  currentQuest.votes[bot.sessionId] = false;
                } else {
                  currentQuest.votes[bot.sessionId] = true;
                }
              }
              // If multiple evil but only requires 1 fail, only the first evil bot fails
              else if (evilBotsOnTeam.length > 1 && !currentQuest.requiresTwoFails) {
                if (bot.sessionId === evilBotsOnTeam[0].sessionId) {
                  currentQuest.votes[bot.sessionId] = false;
                } else {
                  currentQuest.votes[bot.sessionId] = true;
                }
              }
              // Default fail
              else {
                currentQuest.votes[bot.sessionId] = false;
              }
            } else {
              // Normal Mode Play
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
            }
          } else {
            currentQuest.votes[bot.sessionId] = true; // Good always succeeds
          }
        });
        checkQuestVotes(room, io);
      }, 2000);
    }
  } else if (room.status === 'quest_result') {
    // Auto-continue for quest result after 5 seconds if leader is bot
    const leader = room.players[room.gameState.leaderIndex];
    if (leader.isBot) {
      setTimeout(() => {
        if (room.status !== 'quest_result') return;
        applyQuestResult(room, io);
      }, 5000);
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

        // --- Improvement C: Smarter Assassin ---
        const difficulty = room.settings.botDifficulty || 'normal';
        let target = goodPlayers[0];

        if (difficulty === 'hard') {
          let highestMerlinScore = -1;

          goodPlayers.forEach(p => {
            // Base suspicion mapped to 0-40 (max 40)
            const baseSuspicion = Math.min(40, (memory.merlinSuspicion[p.sessionId] || 0) * 0.4);

            // Vote pattern checks: Merlin rejects teams with evil and approves clean teams
            const votes = memory.votePatterns[p.sessionId] || { rejectedEvil: 0, approvedEvil: 0, totalVotes: 1 };
            const voteScore = votes.totalVotes > 0 ? (votes.rejectedEvil / votes.totalVotes) * 30 : 0; // Max 30

            // Fail association: Merlin is rarely on failed quests (Max 15)
            const failDeduction = (memory.failAssociation[p.sessionId] || 0) * 10;
            const participationScore = Math.max(0, 15 - failDeduction);

            // Proposal checks: Merlin rarely proposes teams with evil (Max 15)
            const proposals = room.gameState.voteHistory.filter(h => room.players[h.leaderIndex].sessionId === p.sessionId);
            const cleanProposals = proposals.filter(h => !h.proposedTeam.some(id => memory.knownRoles[id] === 'Evil')).length;
            const proposalScore = proposals.length > 0 ? (cleanProposals / proposals.length) * 15 : 0;

            const totalScore = baseSuspicion + voteScore + participationScore + proposalScore;

            if (totalScore > highestMerlinScore) {
              highestMerlinScore = totalScore;
              target = p;
            }
          });
        } else {
          // Normal Assassin logic: Find the good player with the lowest trust score
          let lowestTrust = 100;
          goodPlayers.forEach(p => {
            const trust = memory.trustScores[p.sessionId] || 50;
            if (trust < lowestTrust) {
              lowestTrust = trust;
              target = p;
            }
          });
        }

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
            settings: { optionalRoles: [], botDifficulty: 'normal' },
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

    socket.on('add_bot', ({ roomId, difficulty }) => {
      try {
        const room = rooms[roomId];
        if (room && room.status === 'lobby' && room.players.length < 10) {
          const botId = 'bot_' + Math.random().toString(36).substring(2, 9);
          room.players.push({
            id: botId,
            sessionId: botId,
            name: `Bot ${room.players.length}`,
            role: null,
            isConnected: true,
            isBot: true
          });

          if (difficulty) {
            room.settings.botDifficulty = difficulty;
          }

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

    socket.on('continue_quest_result', ({ roomId }) => {
      try {
        const room = rooms[roomId];
        if (room && room.status === 'quest_result') {
          touchRoom(room);
          applyQuestResult(room, io);
        }
      } catch (err) {
        console.error('Error in continue_quest_result:', err);
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
