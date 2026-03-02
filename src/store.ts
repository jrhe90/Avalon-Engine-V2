import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { io, Socket } from "socket.io-client";
import { User } from '@supabase/supabase-js';

export type Role =
  | "Merlin"
  | "Assassin"
  | "Percival"
  | "Morgana"
  | "Mordred"
  | "Oberon"
  | "Loyal Servant"
  | "Minion";

export interface Player {
  id: string;
  sessionId: string;
  userId?: string;
  name: string;
  role: Role | null;
  isConnected: boolean;
  isBot?: boolean;
}

export interface Quest {
  teamSize: number;
  requiresTwoFails: boolean;
  status: "pending" | "success" | "fail";
  team: string[];
  votes: Record<string, boolean>;
}

export interface TeamVoteHistory {
  questIndex: number;
  voteTrack: number;
  leaderIndex: number;
  proposedTeam: string[];
  votes: Record<string, boolean>;
  approved: boolean;
}

export interface Room {
  id: string;
  players: Player[];
  status:
  | "lobby"
  | "role_reveal"
  | "team_building"
  | "team_voting"
  | "team_vote_reveal"
  | "quest_voting"
  | "assassin"
  | "game_over";
  settings: {
    optionalRoles: Role[];
  };
  gameState: {
    quests: Quest[];
    currentQuestIndex: number;
    voteTrack: number;
    leaderIndex: number;
    proposedTeam: string[];
    teamVotes: Record<string, boolean>;
    winner: "good" | "evil" | null;
    assassinationTarget: string | null;
    voteHistory: TeamVoteHistory[];
  };
}

export interface UserProfile {
  id: string;
  username: string;
  wins: number;
  losses: number;
  total_games: number;
}

interface GameState {
  user: User | null;
  profile: UserProfile | null;
  setAuth: (user: User | null, profile: UserProfile | null) => void;
  logout: () => void;
  socket: Socket | null;
  room: Room | null;
  sessionId: string;
  name: string;
  roomId: string;
  error: string | null;
  language: 'en' | 'zh';
  devRequestedRole?: Role;
  idleWarning: boolean;
  idleCountdown: number;
  _idleTimer?: ReturnType<typeof setInterval>;
  setLanguage: (lang: 'en' | 'zh') => void;
  setDevRequestedRole: (role?: Role) => void;
  connect: (roomId: string, name: string) => void;
  updateSettings: (settings: Room["settings"]) => void;
  addBot: () => void;
  startGame: (requestedRoles?: Record<string, Role>) => void;
  leaveRoom: () => void;
  kickPlayer: (targetSessionId: string) => void;
  endGame: () => void;
  restartGame: () => void;
  readyTeamBuilding: () => void;
  proposeTeam: (team: string[]) => void;
  voteTeam: (approve: boolean) => void;
  voteQuest: (success: boolean) => void;
  assassinate: (targetSessionId: string) => void;
  continueVoteReveal: () => void;
  pingActivity: () => void;
}

const generateSessionId = () => {
  return Math.random().toString(36).substring(2, 15);
};

export const useGameStore = create<GameState>()(
  persist(
    (set, get) => ({
      user: null,
      profile: null,
      setAuth: (user, profile) => set({ user, profile, name: profile?.username || get().name }),
      logout: () => set({ user: null, profile: null }),
      socket: null,
      room: null,
      sessionId: generateSessionId(),
      name: "",
      roomId: "",
      error: null,
      language: 'en',
      devRequestedRole: undefined,
      idleWarning: false,
      idleCountdown: 0,

      setLanguage: (lang) => set({ language: lang }),
      setDevRequestedRole: (role) => set({ devRequestedRole: role }),

      connect: async (roomId: string, name: string) => {
        const { socket: existingSocket, sessionId } = get();
        if (existingSocket) {
          existingSocket.disconnect();
        }

        const socketUrl =
          (import.meta as any).env.VITE_APP_URL || window.location.origin;
        const socket = io(socketUrl);

        // Get current Supabase session token (wrapped in try-catch for offline mode)
        let token = undefined;
        try {
          const { supabase } = await import('./utils/supabase');
          const { data: { session } } = await supabase.auth.getSession();
          token = session?.access_token;
        } catch (err) {
          console.log('Skipping Supabase auth for socket connection (offline mode)');
        }

        socket.on("connect", () => {
          socket.emit("join_room", { roomId, sessionId, name, token });
        });

        socket.on("room_update", (room: Room) => {
          set({ room, error: null });
        });

        socket.on("error", (err: { message: string }) => {
          set({ error: err.message });
        });

        socket.on("kicked", () => {
          set({ error: "You have been kicked from the room." });
          get().leaveRoom();
        });

        socket.on("game_ended", (data?: { reason?: string }) => {
          const timer = get()._idleTimer;
          if (timer) clearInterval(timer);
          set({ error: data?.reason === 'idle_timeout' ? 'Room closed due to inactivity.' : 'The host has ended the game.', idleWarning: false, idleCountdown: 0, _idleTimer: undefined });
          get().leaveRoom();
        });

        socket.on("room_idle_warning", ({ countdown }: { countdown: number }) => {
          // Start local countdown
          set({ idleWarning: true, idleCountdown: countdown });
          const timer = setInterval(() => {
            const current = get().idleCountdown;
            if (current <= 1) {
              clearInterval(timer);
              set({ idleCountdown: 0, _idleTimer: undefined });
            } else {
              set({ idleCountdown: current - 1 });
            }
          }, 1000);
          set({ _idleTimer: timer });
        });

        socket.on("room_idle_cancelled", () => {
          const timer = get()._idleTimer;
          if (timer) clearInterval(timer);
          set({ idleWarning: false, idleCountdown: 0, _idleTimer: undefined });
        });

        set({ socket, roomId, name });
      },

      updateSettings: (settings) => {
        const { socket, roomId } = get();
        socket?.emit("update_settings", { roomId, settings });
      },

      addBot: () => {
        const { socket, roomId } = get();
        socket?.emit("add_bot", { roomId });
      },

      startGame: (requestedRoles) => {
        const { socket, roomId } = get();
        socket?.emit("start_game", { roomId, requestedRoles });
      },

      leaveRoom: () => {
        const { socket, roomId, sessionId } = get();
        if (socket) {
          socket.emit("leave_room", { roomId, sessionId });
          socket.disconnect();
        }
        set({ socket: null, room: null, roomId: "" });
      },

      kickPlayer: (targetSessionId: string) => {
        const { socket, roomId } = get();
        socket?.emit("kick_player", { roomId, targetSessionId });
      },

      endGame: () => {
        const { socket, roomId } = get();
        socket?.emit("end_game", { roomId });
      },

      readyTeamBuilding: () => {
        const { socket, roomId } = get();
        socket?.emit("ready_team_building", { roomId });
      },

      proposeTeam: (team) => {
        const { socket, roomId } = get();
        socket?.emit("propose_team", { roomId, team });
      },

      voteTeam: (approve) => {
        const { socket, roomId, sessionId } = get();
        socket?.emit("vote_team", { roomId, sessionId, approve });
      },

      voteQuest: (success) => {
        const { socket, roomId, sessionId } = get();
        socket?.emit("vote_quest", { roomId, sessionId, success });
      },

      assassinate: (targetSessionId) => {
        const { socket, roomId, sessionId } = get();
        socket?.emit("assassinate", { roomId, sessionId, targetSessionId });
      },

      continueVoteReveal: () => {
        const { socket, roomId } = get();
        socket?.emit("continue_vote_reveal", { roomId });
      },

      restartGame: () => {
        const { socket, roomId } = get();
        socket?.emit("restart_game", { roomId });
      },

      pingActivity: () => {
        const { socket, roomId, _idleTimer } = get();
        socket?.emit("room_activity_ping", { roomId });
        if (_idleTimer) clearInterval(_idleTimer);
        set({ idleWarning: false, idleCountdown: 0, _idleTimer: undefined });
      },
    }),
    {
      name: 'avalon-storage',
      // Only persist these specific fields to localStorage
      partialize: (state) => ({
        sessionId: state.sessionId,
        name: state.name,
        roomId: state.roomId,
        language: state.language
      }),
    }
  )
);
