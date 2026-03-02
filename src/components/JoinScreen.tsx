import React, { useState } from "react";
import { useGameStore } from "../store";
import { Lock, KeyRound, User, Users, LogOut, Trophy, Swords } from "lucide-react";
import { useTranslation } from "../utils/i18n";
import { supabase } from "../utils/supabase";

export default function JoinScreen() {
  const [roomId, setRoomId] = useState("");
  const [name, setName] = useState(useGameStore(state => state.name) || "");
  const [inviteCode, setInviteCode] = useState("");
  const [localError, setLocalError] = useState("");
  const connect = useGameStore((state) => state.connect);
  const error = useGameStore((state) => state.error);
  const profile = useGameStore((state) => state.profile);
  const logout = useGameStore((state) => state.logout);
  const { t } = useTranslation();

  const handleJoin = (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError("");

    if (inviteCode !== "dagong") {
      setLocalError(t("The secret passphrase is incorrect."));
      return;
    }

    if (roomId && name) {
      connect(roomId.toUpperCase(), name);
    }
  };

  const handleLogout = async () => {
    try {
      await supabase.auth.signOut();
    } catch (err) {
      console.log('Sign out from Supabase failed (offline mode), proceeding with local logout');
    }
    logout();
  };

  const winRate = profile?.total_games ? Math.round((profile.wins / profile.total_games) * 100) : 0;

  return (
    <div className="min-h-screen bg-[#050505] text-zinc-50 flex items-center justify-center p-4 relative overflow-hidden">
      {/* Atmospheric Background */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[600px] bg-amber-900/20 rounded-full blur-[120px] opacity-50 pointer-events-none" />
      <div className="absolute bottom-0 right-0 w-[600px] h-[600px] bg-yellow-900/10 rounded-full blur-[100px] opacity-30 pointer-events-none" />

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

          <div className="text-center mb-10">
            <h1 className="text-5xl font-serif font-bold mb-3 tracking-tight text-transparent bg-clip-text bg-gradient-to-b from-amber-100 to-amber-500 drop-shadow-sm">
              Avalon
            </h1>
            <p className="text-amber-500/60 text-xs uppercase tracking-[0.3em] font-medium">
              {t("A Game of Hidden Loyalty")}
            </p>
          </div>

          {(error || localError) && (
            <div className="bg-red-950/40 border border-red-900/50 text-red-400 p-4 rounded-xl mb-6 text-sm text-center backdrop-blur-sm">
              {error || localError}
            </div>
          )}

          <form onSubmit={handleJoin} className="space-y-6">

            {/* Secret Passphrase Section */}
            <div className="relative pt-4 pb-2">
              <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-[#0a0a0a] border border-amber-900/30 rounded-full p-2 text-amber-500 shadow-lg z-10">
                <Lock size={16} />
              </div>
              <div className="bg-black/40 border border-amber-900/30 rounded-2xl p-1 relative overflow-hidden group focus-within:border-amber-500/50 transition-colors">
                <div className="absolute inset-0 bg-gradient-to-r from-amber-900/0 via-amber-900/10 to-amber-900/0 opacity-0 group-focus-within:opacity-100 transition-opacity" />
                <input
                  type="text"
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value)}
                  className="w-full bg-transparent px-4 py-4 text-center text-amber-100 placeholder:text-amber-900/50 focus:outline-none tracking-widest relative z-10"
                  placeholder={t("Enter Passphrase")}
                  required
                />
              </div>
            </div>

            <div className="h-px w-full bg-gradient-to-r from-transparent via-amber-900/20 to-transparent my-2" />

            {/* Standard Inputs */}
            <div className="space-y-4">
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
            </div>

            <button
              type="submit"
              className="w-full relative group overflow-hidden rounded-xl mt-8"
            >
              <div className="absolute inset-0 bg-gradient-to-r from-amber-600 to-yellow-600 transition-transform duration-300 group-hover:scale-105" />
              <div className="relative px-4 py-4 flex items-center justify-center gap-2 text-black font-bold tracking-wide">
                <KeyRound size={18} />
                <span>{t("Join Room")}</span>
              </div>
            </button>
          </form>
        </div>

        <p className="text-center text-zinc-600 text-xs mt-8 font-serif italic">
          "The truth is hidden in the mist."
        </p>
      </div>
    </div>
  );
}
