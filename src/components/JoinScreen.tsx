import React, { useState, useEffect } from "react";
import { useGameStore } from "../store";
import { KeyRound, User, Users, LogOut, Trophy, Swords, RefreshCw, Crown, Loader2 } from "lucide-react";
import { useTranslation } from "../utils/i18n";
import { supabase } from "../utils/supabase";
import { cn } from "../utils/cn";

export default function JoinScreen() {
  const [roomId, setRoomId] = useState("");
  const [name, setName] = useState(useGameStore(state => state.name) || "");
  const [activeTab, setActiveTab] = useState<'join' | 'browse'>('join');
  const [loadingRooms, setLoadingRooms] = useState(false);
  const connect = useGameStore((state) => state.connect);
  const error = useGameStore((state) => state.error);
  const profile = useGameStore((state) => state.profile);
  const logout = useGameStore((state) => state.logout);
  const availableRooms = useGameStore((state) => state.availableRooms);
  const fetchRooms = useGameStore((state) => state.fetchRooms);
  const { t } = useTranslation();

  useEffect(() => {
    if (activeTab === 'browse') {
      handleRefresh();
    }
  }, [activeTab]);

  const handleJoin = (e: React.FormEvent) => {
    e.preventDefault();
    if (roomId && name) {
      connect(roomId.toUpperCase(), name);
    }
  };

  const handleJoinRoom = (id: string) => {
    const playerName = name || profile?.username || `Player_${Math.floor(Math.random() * 1000)}`;
    connect(id, playerName);
  };

  const handleRefresh = async () => {
    setLoadingRooms(true);
    await fetchRooms();
    setLoadingRooms(false);
  };

  const handleLogout = async () => {
    try {
      await supabase.auth.signOut();
    } catch (err) {
      console.log('Sign out from Supabase failed, proceeding with local logout');
    }
    logout();
  };

  const winRate = profile?.total_games ? Math.round((profile.wins / profile.total_games) * 100) : 0;

  return (
    <div className="min-h-screen text-zinc-50 flex items-center justify-center p-4 relative overflow-hidden">
      {/* Background Image */}
      <div
        className="absolute inset-0 bg-cover bg-center bg-no-repeat"
        style={{ backgroundImage: 'url(/join-bg.jpg)' }}
      />
      <div className="absolute inset-0 bg-gradient-to-b from-zinc-950/80 via-zinc-950/85 to-zinc-950/95" />

      <div className="w-full max-w-md relative z-10">

        {/* User Profile Card */}
        {profile && (
          <div className="mb-6 bg-zinc-900/80 backdrop-blur-md border border-zinc-800 rounded-2xl p-4 flex items-center justify-between shadow-lg">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 bg-indigo-950/50 border border-indigo-500/30 rounded-full flex items-center justify-center text-indigo-400 font-serif text-xl">
                {profile.username.charAt(0).toUpperCase()}
              </div>
              <div>
                <h3 className="font-medium text-zinc-200">{profile.username}</h3>
                <div className="flex items-center gap-3 text-xs text-zinc-500 mt-1">
                  <span className="flex items-center gap-1"><Swords size={12} /> {profile.total_games} Games</span>
                  <span className="flex items-center gap-1 text-emerald-500/70"><Trophy size={12} /> {winRate}% WR</span>
                </div>
              </div>
            </div>
            <button
              onClick={handleLogout}
              className="p-2 text-zinc-500 hover:text-red-400 hover:bg-red-950/30 rounded-lg transition-colors"
              title="Sign Out"
            >
              <LogOut size={18} />
            </button>
          </div>
        )}

        <div className="bg-zinc-950/60 backdrop-blur-2xl border border-amber-900/30 rounded-3xl p-8 shadow-[0_0_40px_rgba(0,0,0,0.5)]">

          <div className="text-center mb-8">
            <h1 className="text-5xl font-serif font-bold mb-3 tracking-tight text-transparent bg-clip-text bg-gradient-to-b from-amber-100 to-amber-500 drop-shadow-sm">
              Avalon
            </h1>
            <p className="text-amber-500/60 text-xs uppercase tracking-[0.3em] font-medium">
              {t("A Game of Hidden Loyalty")}
            </p>
          </div>

          {(error) && (
            <div className="bg-red-950/40 border border-red-900/50 text-red-400 p-4 rounded-xl mb-6 text-sm text-center backdrop-blur-sm">
              {error}
            </div>
          )}

          {/* Tab Switcher */}
          <div className="flex mb-6 bg-black/30 rounded-xl p-1 border border-white/5">
            <button
              onClick={() => setActiveTab('join')}
              className={cn(
                "flex-1 py-2.5 rounded-lg text-sm font-medium transition-all",
                activeTab === 'join'
                  ? "bg-amber-600/20 text-amber-400 border border-amber-500/30"
                  : "text-zinc-500 hover:text-zinc-300"
              )}
            >
              {t("Join Room")}
            </button>
            <button
              onClick={() => setActiveTab('browse')}
              className={cn(
                "flex-1 py-2.5 rounded-lg text-sm font-medium transition-all",
                activeTab === 'browse'
                  ? "bg-amber-600/20 text-amber-400 border border-amber-500/30"
                  : "text-zinc-500 hover:text-zinc-300"
              )}
            >
              {t("Browse Rooms")}
            </button>
          </div>

          {/* Tab Content */}
          {activeTab === 'join' ? (
            <form onSubmit={handleJoin} className="space-y-4">
              <div>
                <label className="block text-[10px] font-medium text-amber-500/50 uppercase tracking-widest mb-2 ml-1">
                  {t("Room Code")}
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none text-amber-700/50">
                    <Users size={18} />
                  </div>
                  <input
                    type="text"
                    value={roomId}
                    onChange={(e) => setRoomId(e.target.value)}
                    className="w-full bg-black/20 border border-white/5 rounded-xl pl-11 pr-4 py-3 text-lg font-mono uppercase text-zinc-200 placeholder:text-zinc-700 focus:outline-none focus:border-amber-500/50 focus:bg-black/40 transition-all"
                    placeholder="e.g. ABCD"
                    maxLength={6}
                    required
                  />
                </div>
              </div>

              <div>
                <label className="block text-[10px] font-medium text-amber-500/50 uppercase tracking-widest mb-2 ml-1">
                  {t("Your Identity")}
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none text-amber-700/50">
                    <User size={18} />
                  </div>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full bg-black/20 border border-white/5 rounded-xl pl-11 pr-4 py-3 text-lg text-zinc-200 placeholder:text-zinc-700 focus:outline-none focus:border-amber-500/50 focus:bg-black/40 transition-all"
                    placeholder={t("Enter your name")}
                    maxLength={15}
                    required
                  />
                </div>
              </div>

              <button
                type="submit"
                className="w-full relative group overflow-hidden rounded-xl mt-4"
              >
                <div className="absolute inset-0 bg-gradient-to-r from-amber-600 to-yellow-600 transition-transform duration-300 group-hover:scale-105" />
                <div className="relative px-4 py-4 flex items-center justify-center gap-2 text-black font-bold tracking-wide">
                  <KeyRound size={18} />
                  <span>{t("Join Room")}</span>
                </div>
              </button>
            </form>
          ) : (
            <div className="space-y-3">
              {/* Refresh button */}
              <div className="flex items-center justify-between mb-2">
                <p className="text-zinc-500 text-xs">{t("Available Rooms")}</p>
                <button
                  onClick={handleRefresh}
                  disabled={loadingRooms}
                  className="p-1.5 text-zinc-500 hover:text-amber-400 transition-colors rounded-lg hover:bg-amber-950/30"
                >
                  <RefreshCw size={14} className={loadingRooms ? 'animate-spin' : ''} />
                </button>
              </div>

              {loadingRooms ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 size={24} className="animate-spin text-amber-500/50" />
                </div>
              ) : availableRooms.length === 0 ? (
                <div className="text-center py-12 text-zinc-600">
                  <Users size={32} className="mx-auto mb-3 opacity-40" />
                  <p className="text-sm">{t("No rooms available")}</p>
                  <p className="text-xs mt-1 text-zinc-700">{t("Create one from the Join tab")}</p>
                </div>
              ) : (
                <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1">
                  {availableRooms.map((room) => {
                    const isWaiting = room.status === 'waiting';
                    return (
                      <button
                        key={room.id}
                        onClick={() => isWaiting && handleJoinRoom(room.id)}
                        disabled={!isWaiting}
                        className={cn(
                          "w-full flex items-center justify-between p-4 rounded-xl border transition-all text-left",
                          isWaiting
                            ? "bg-black/20 border-white/5 hover:border-amber-500/30 hover:bg-amber-950/20 cursor-pointer"
                            : "bg-black/10 border-white/5 opacity-50 cursor-not-allowed"
                        )}
                      >
                        <div className="flex items-center gap-3">
                          <div className="w-9 h-9 bg-amber-950/40 border border-amber-500/20 rounded-lg flex items-center justify-center">
                            <Crown size={16} className="text-amber-500/70" />
                          </div>
                          <div>
                            <p className="text-sm font-medium text-zinc-200 font-mono">{room.id}</p>
                            <p className="text-xs text-zinc-500 mt-0.5">{room.hostName}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="text-xs text-zinc-500 font-mono">
                            {room.playerCount}/{room.maxPlayers}
                          </span>
                          <span className={cn(
                            "px-2 py-0.5 rounded-full text-[10px] font-medium uppercase tracking-wider",
                            isWaiting
                              ? "bg-emerald-950/50 text-emerald-400 border border-emerald-500/20"
                              : "bg-red-950/50 text-red-400 border border-red-500/20"
                          )}>
                            {isWaiting ? t("Waiting") : t("In Game")}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        <p className="text-center text-zinc-600 text-xs mt-8 font-serif italic">
          "The truth is hidden in the mist."
        </p>
      </div>
    </div>
  );
}
