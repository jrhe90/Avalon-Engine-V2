import { useGameStore, Role } from "../store";
import { Users, Settings, Play, LogOut, Bot, UserMinus, Plus, ChevronDown } from "lucide-react";
import { useTranslation } from "../utils/i18n";
import { useState } from "react";

export default function LobbyScreen() {
  const room = useGameStore((state) => state.room);
  const sessionId = useGameStore((state) => state.sessionId);
  const updateSettings = useGameStore((state) => state.updateSettings);
  const startGame = useGameStore((state) => state.startGame);
  const leaveRoom = useGameStore((state) => state.leaveRoom);
  const addBot = useGameStore((state) => state.addBot);
  const kickPlayer = useGameStore((state) => state.kickPlayer);
  const endGame = useGameStore((state) => state.endGame);
  const devRequestedRole = useGameStore((state) => state.devRequestedRole);
  const { t } = useTranslation();
  const [showBotMenu, setShowBotMenu] = useState(false);

  if (!room) return null;

  const isHost = room.players[0]?.sessionId === sessionId;
  const canStart = room.players.length >= 5 && room.players.length <= 10;
  const canAddBot = isHost && room.players.length < 10;

  const toggleRole = (role: Role) => {
    if (!isHost) return;
    const current = room.settings.optionalRoles;
    const updated = current.includes(role)
      ? current.filter((r) => r !== role)
      : [...current, role];
    updateSettings({ optionalRoles: updated });
  };

  return (
    <div className="min-h-screen text-zinc-50 relative overflow-hidden">
      {/* Background Image */}
      <div
        className="absolute inset-0 bg-cover bg-center bg-no-repeat"
        style={{ backgroundImage: 'url(/lobby-bg.png)' }}
      />
      {/* Dark overlay for readability */}
      <div className="absolute inset-0 bg-gradient-to-b from-zinc-950/60 via-zinc-950/75 to-zinc-950/95" />

      <div className="relative z-10 p-6 flex flex-col max-w-md mx-auto min-h-screen">
        <header className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-serif font-bold tracking-tight">
              {t("Room")} {room.id}
            </h1>
            <p className="text-zinc-400 text-sm">{t("Waiting for players...")}</p>
          </div>
          <div className="flex items-center gap-3">
            <div className="bg-zinc-900/70 backdrop-blur-sm px-3 py-1 rounded-full border border-zinc-700/50 flex items-center gap-2">
              <Users size={16} className="text-zinc-400" />
              <span className="font-mono text-sm">{room.players.length}/10</span>
            </div>
            {isHost ? (
              <button
                onClick={endGame}
                className="p-2 bg-zinc-900/70 backdrop-blur-sm hover:bg-red-900/40 border border-zinc-700/50 hover:border-red-500/50 rounded-full text-zinc-400 hover:text-red-400 transition-colors"
                title={t("End Game")}
              >
                <LogOut size={16} />
              </button>
            ) : (
              <button
                onClick={leaveRoom}
                className="p-2 bg-zinc-900/70 backdrop-blur-sm hover:bg-zinc-800 border border-zinc-700/50 rounded-full text-zinc-400 transition-colors"
                title={t("Leave Room")}
              >
                <LogOut size={16} />
              </button>
            )}
          </div>
        </header>

        <div className="flex-1 space-y-8">
          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xs font-medium text-zinc-400 uppercase tracking-wider">
                {t("Players")}
              </h2>
              {canAddBot && (
                <div className="relative">
                  <button
                    onClick={() => setShowBotMenu(!showBotMenu)}
                    className="text-xs flex items-center gap-1 text-indigo-400 hover:text-indigo-300 transition-colors bg-indigo-500/10 px-2 py-1 rounded-md border border-indigo-500/20"
                  >
                    <Plus size={14} /> {t("Add Bot")} <ChevronDown size={12} className={`transition-transform ${showBotMenu ? 'rotate-180' : ''}`} />
                  </button>

                  {showBotMenu && (
                    <div className="absolute right-0 top-full mt-1 bg-zinc-900 border border-zinc-700/50 rounded-lg shadow-xl overflow-hidden z-20 min-w-[140px]">
                      <button
                        onClick={() => { addBot('normal'); setShowBotMenu(false); }}
                        className="w-full text-left px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800 hover:text-white transition-colors flex items-center gap-2"
                      >
                        <Bot size={14} className="text-zinc-400" />
                        {t("Normal Bot")}
                      </button>
                      <button
                        onClick={() => { addBot('hard'); setShowBotMenu(false); }}
                        className="w-full text-left px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800 hover:text-white transition-colors flex items-center gap-2 border-t border-zinc-800"
                      >
                        <Bot size={14} className="text-amber-500" />
                        {t("Hard Bot")}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
            <ul className="space-y-2">
              {room.players.map((p, i) => (
                <li
                  key={p.sessionId}
                  className="bg-zinc-900/60 backdrop-blur-sm border border-zinc-700/40 rounded-xl p-4 flex items-center justify-between"
                >
                  <span className="font-medium flex items-center gap-2">
                    {p.name} {p.sessionId === sessionId && "(You)"}
                    {p.isBot && <Bot size={14} className={room.settings.botDifficulty === "hard" ? "text-amber-500" : "text-zinc-500"} />}
                  </span>
                  <div className="flex items-center gap-2">
                    {i === 0 && (
                      <span className="text-xs bg-indigo-500/20 text-indigo-400 px-2 py-1 rounded-md">
                        {t("Host")}
                      </span>
                    )}
                    {!p.isConnected && !p.isBot && (
                      <span className="text-xs bg-red-500/20 text-red-400 px-2 py-1 rounded-md">
                        {t("Offline")}
                      </span>
                    )}
                    {isHost && i !== 0 && (
                      <button
                        onClick={() => kickPlayer(p.sessionId)}
                        className="p-1.5 text-zinc-500 hover:text-red-400 hover:bg-red-500/10 rounded-md transition-colors"
                        title={t("Kick")}
                      >
                        <UserMinus size={14} />
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <div className="flex items-center gap-2 mb-3">
              <Settings size={16} className="text-zinc-400" />
              <h2 className="text-xs font-medium text-zinc-400 uppercase tracking-wider">
                {t("Roles in play")} ({room.players.length} {t("Players")})
              </h2>
            </div>
            <div className="bg-zinc-900/60 backdrop-blur-sm border border-zinc-700/40 rounded-xl p-4 text-sm text-zinc-300">
              {room.players.length < 5 && t("Need at least 5 players")}
              {room.players.length === 5 && `${t("Merlin")}, ${t("Percival")}, ${t("Loyal Servant")}, ${t("Morgana")}, ${t("Assassin")}`}
              {room.players.length === 6 && `${t("Merlin")}, ${t("Percival")}, ${t("Loyal Servant")} x2, ${t("Morgana")}, ${t("Assassin")}`}
              {room.players.length === 7 && `${t("Merlin")}, ${t("Percival")}, ${t("Loyal Servant")} x2, ${t("Morgana")}, ${t("Assassin")}, ${t("Oberon")}`}
              {room.players.length === 8 && `${t("Merlin")}, ${t("Percival")}, ${t("Loyal Servant")} x3, ${t("Morgana")}, ${t("Assassin")}, ${t("Minion")}`}
              {room.players.length === 9 && `${t("Merlin")}, ${t("Percival")}, ${t("Loyal Servant")} x4, ${t("Morgana")}, ${t("Assassin")}, ${t("Mordred")}`}
              {room.players.length === 10 && `${t("Merlin")}, ${t("Percival")}, ${t("Loyal Servant")} x4, ${t("Morgana")}, ${t("Assassin")}, ${t("Oberon")}, ${t("Mordred")}`}
            </div>
          </section>
        </div>

        {isHost && (
          <div className="mt-8 pt-4 border-t border-zinc-700/30">
            <button
              onClick={() => startGame(devRequestedRole ? { [sessionId]: devRequestedRole } : undefined)}
              disabled={!canStart}
              className={`w-full flex items-center justify-center gap-2 py-4 rounded-xl font-medium transition-colors ${canStart
                ? "bg-emerald-600 hover:bg-emerald-500 text-white"
                : "bg-zinc-800/70 text-zinc-500 cursor-not-allowed"
                }`}
            >
              <Play size={20} />
              {canStart ? t("Start Game") : t("Need 5-10 players")}
            </button>
          </div>
        )}
        {!isHost && (
          <div className="mt-8 pt-4 border-t border-zinc-700/30 text-center text-zinc-400 text-sm">
            {t("Waiting for host to start")}
          </div>
        )}
      </div>
    </div>
  );
}
