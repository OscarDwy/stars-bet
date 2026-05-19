import React, { useState, useEffect, useCallback } from 'react';
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
} from 'firebase/auth';
import {
  collection,
  doc,
  setDoc,
  getDoc,
  updateDoc,
  onSnapshot,
  query,
  orderBy,
  serverTimestamp,
  runTransaction,
  addDoc,
  arrayUnion,
} from 'firebase/firestore';
import { auth, db } from './firebase.js';

const COTE_MIN_FACTOR = 0.7;
const COTE_MAX_FACTOR = 1.3;
const RECHARGE_AMOUNT = 500;
const RECHARGE_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const INITIAL_STARS = 1000;

// Convertit un pseudo en email factice pour Firebase Auth
// (Firebase Auth exige un email, mais on cache ça à l'utilisateur)
const pseudoToEmail = (pseudo) => `${pseudo.toLowerCase()}@starsbets.local`;

function computeEffectiveCote(bet, optionId) {
  const option = bet.options.find((o) => o.id === optionId);
  if (!option) return 1;
  const totalStake = bet.options.reduce((s, o) => s + (o.totalStake || 0), 0);
  if (totalStake === 0) return option.coteBase;
  const numOptions = bet.options.length;
  const expectedShare = 1 / numOptions;
  const actualShare = (option.totalStake || 0) / totalStake;
  const ratio = actualShare / expectedShare;
  let factor;
  if (ratio >= 1) {
    const t = Math.min((ratio - 1) / (numOptions - 1), 1);
    factor = 1 - t * (1 - COTE_MIN_FACTOR);
  } else {
    const t = 1 - ratio;
    factor = 1 + t * (COTE_MAX_FACTOR - 1);
  }
  return option.coteBase * factor;
}

function formatDate(ts) {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' }) +
    ' ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

export default function App() {
  const [authUser, setAuthUser] = useState(null);
  const [userDoc, setUserDoc] = useState(null);
  const [bets, setBets] = useState([]);
  const [users, setUsers] = useState({});
  const [adminPseudo, setAdminPseudo] = useState(null);
  const [activeTab, setActiveTab] = useState('bets');
  const [toast, setToast] = useState(null);
  const [loading, setLoading] = useState(true);
  const [pendingClose, setPendingClose] = useState(null);

  const showToast = useCallback((message, type = 'info') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  }, []);

  // Surveille l'état d'auth
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      setAuthUser(u);
      if (u) {
        const docRef = doc(db, 'users', u.uid);
        const snap = await getDoc(docRef);
        if (snap.exists()) setUserDoc({ id: u.uid, ...snap.data() });
      } else {
        setUserDoc(null);
      }
      setLoading(false);
    });
    return unsub;
  }, []);

  // Écoute les paris en temps réel
  useEffect(() => {
    if (!authUser) return;
    const q = query(collection(db, 'bets'), orderBy('createdAt', 'desc'));
    const unsub = onSnapshot(q, (snap) => {
      setBets(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    return unsub;
  }, [authUser]);

  // Écoute tous les utilisateurs (pour le leaderboard)
  useEffect(() => {
    if (!authUser) return;
    const unsub = onSnapshot(collection(db, 'users'), (snap) => {
      const map = {};
      snap.docs.forEach((d) => { map[d.id] = { id: d.id, ...d.data() }; });
      setUsers(map);
      // mettre à jour aussi le userDoc courant
      if (authUser && map[authUser.uid]) setUserDoc(map[authUser.uid]);
    });
    return unsub;
  }, [authUser]);

  // Écoute le pseudo admin (config globale)
  useEffect(() => {
    if (!authUser) return;
    const unsub = onSnapshot(doc(db, 'config', 'admin'), (snap) => {
      if (snap.exists()) setAdminPseudo(snap.data().pseudo);
    });
    return unsub;
  }, [authUser]);

  const isAdmin = userDoc && adminPseudo && userDoc.pseudo === adminPseudo;

  // --- Auth ---
  const handleSignup = async (pseudo, password) => {
    pseudo = pseudo.trim();
    if (!pseudo || pseudo.length > 20) return showToast('Pseudo invalide (1-20 caractères)', 'danger');
    if (!/^[a-zA-Z0-9_-]+$/.test(pseudo)) return showToast('Lettres, chiffres, _ et - uniquement', 'danger');
    if (password.length < 6) return showToast('Mot de passe : 6 caractères minimum', 'danger');
    try {
      const cred = await createUserWithEmailAndPassword(auth, pseudoToEmail(pseudo), password);
      // Crée le user doc
      await setDoc(doc(db, 'users', cred.user.uid), {
        pseudo,
        stars: INITIAL_STARS,
        lastRecharge: 0,
        wins: 0,
        losses: 0,
        totalWon: 0,
        createdAt: serverTimestamp(),
      });
      // Premier compte = admin
      const adminConfig = await getDoc(doc(db, 'config', 'admin'));
      if (!adminConfig.exists()) {
        await setDoc(doc(db, 'config', 'admin'), { pseudo });
      }
      showToast('Compte créé', 'success');
    } catch (e) {
      if (e.code === 'auth/email-already-in-use') showToast('Pseudo déjà pris', 'danger');
      else showToast('Erreur : ' + e.message, 'danger');
    }
  };

  const handleLogin = async (pseudo, password) => {
    try {
      await signInWithEmailAndPassword(auth, pseudoToEmail(pseudo.trim()), password);
      showToast('Connecté', 'success');
    } catch (e) {
      if (e.code === 'auth/invalid-credential' || e.code === 'auth/wrong-password' || e.code === 'auth/user-not-found') {
        showToast('Pseudo ou mot de passe incorrect', 'danger');
      } else {
        showToast('Erreur : ' + e.message, 'danger');
      }
    }
  };

  const handleLogout = () => signOut(auth);

  // --- Recharge ---
  const handleRecharge = async () => {
    const now = Date.now();
    if (now - (userDoc.lastRecharge || 0) < RECHARGE_COOLDOWN_MS) {
      const h = Math.ceil((RECHARGE_COOLDOWN_MS - (now - userDoc.lastRecharge)) / (60 * 60 * 1000));
      return showToast(`Recharge dispo dans ${h}h`, 'danger');
    }
    await updateDoc(doc(db, 'users', authUser.uid), {
      stars: (userDoc.stars || 0) + RECHARGE_AMOUNT,
      lastRecharge: now,
    });
    showToast(`+${RECHARGE_AMOUNT} stars`, 'success');
  };

  // --- Créer un pari ---
  const handleCreateBet = async (data) => {
    const bet = {
      title: data.title,
      description: data.description,
      createdBy: userDoc.pseudo,
      createdAt: serverTimestamp(),
      status: 'open',
      options: data.options.map((opt, i) => ({
        id: 'opt_' + i + '_' + Math.random().toString(36).slice(2, 7),
        name: opt.name,
        coteBase: opt.coteBase,
        totalStake: 0,
        bets: [],
      })),
      comments: [],
      winningOptionIds: [],
    };
    await addDoc(collection(db, 'bets'), bet);
    showToast('Pari créé', 'success');
    setActiveTab('bets');
  };

  // --- Placer une mise (transaction pour éviter les race conditions) ---
  const handlePlaceBet = async (betId, optionId, amount) => {
    if (amount <= 0) return showToast('Mise invalide', 'danger');
    if (amount > userDoc.stars) return showToast('Pas assez de stars', 'danger');
    try {
      await runTransaction(db, async (tx) => {
        const betRef = doc(db, 'bets', betId);
        const userRef = doc(db, 'users', authUser.uid);
        const betSnap = await tx.get(betRef);
        const userSnap = await tx.get(userRef);
        if (!betSnap.exists() || !userSnap.exists()) throw new Error('Document absent');
        const betData = betSnap.data();
        if (betData.status !== 'open') throw new Error('Pari fermé');
        const userData = userSnap.data();
        if (amount > userData.stars) throw new Error('Solde insuffisant');
        const coteAtBet = computeEffectiveCote(betData, optionId);
        const newOptions = betData.options.map((opt) => {
          if (opt.id !== optionId) return opt;
          return {
            ...opt,
            totalStake: (opt.totalStake || 0) + amount,
            bets: [...(opt.bets || []), {
              user: userData.pseudo,
              userId: authUser.uid,
              amount,
              coteAtBet: Math.round(coteAtBet * 100) / 100,
              timestamp: Date.now(),
            }],
          };
        });
        tx.update(betRef, { options: newOptions });
        tx.update(userRef, { stars: userData.stars - amount });
      });
      showToast('Mise enregistrée', 'success');
    } catch (e) {
      showToast('Erreur : ' + e.message, 'danger');
    }
  };

  // --- Clôturer un pari et distribuer les gains ---
  const handleCloseBet = async (betId, winningOptionId) => {
    try {
      await runTransaction(db, async (tx) => {
        const betRef = doc(db, 'bets', betId);
        const betSnap = await tx.get(betRef);
        if (!betSnap.exists()) throw new Error('Pari introuvable');
        const betData = betSnap.data();
        if (betData.status !== 'open') throw new Error('Déjà clôturé');

        // Récupérer tous les users qui ont parié (lecture)
        const userIds = new Set();
        betData.options.forEach((opt) => (opt.bets || []).forEach((b) => userIds.add(b.userId)));
        const userSnaps = {};
        for (const uid of userIds) {
          const r = doc(db, 'users', uid);
          userSnaps[uid] = { ref: r, snap: await tx.get(r) };
        }

        // Calculer les modifications
        const userUpdates = {};
        userIds.forEach((uid) => {
          const data = userSnaps[uid].snap.data();
          userUpdates[uid] = {
            stars: data.stars || 0,
            wins: data.wins || 0,
            losses: data.losses || 0,
            totalWon: data.totalWon || 0,
            newHistory: [],
          };
        });

        betData.options.forEach((opt) => {
          const isWinner = opt.id === winningOptionId;
          (opt.bets || []).forEach((b) => {
            const u = userUpdates[b.userId];
            if (!u) return;
            if (isWinner) {
              const payout = Math.round(b.amount * b.coteAtBet);
              u.stars += payout;
              u.wins += 1;
              u.totalWon += payout - b.amount;
              u.newHistory.push({
                betId, betTitle: betData.title, optionName: opt.name,
                stake: b.amount, payout, result: 'win', timestamp: Date.now(),
              });
            } else {
              u.losses += 1;
              u.newHistory.push({
                betId, betTitle: betData.title, optionName: opt.name,
                stake: b.amount, payout: 0, result: 'loss', timestamp: Date.now(),
              });
            }
          });
        });

        // Écritures
        tx.update(betRef, {
          status: 'closed',
          winningOptionIds: [winningOptionId],
          closedAt: Date.now(),
        });
        userIds.forEach((uid) => {
          const u = userUpdates[uid];
          tx.update(userSnaps[uid].ref, {
            stars: u.stars,
            wins: u.wins,
            losses: u.losses,
            totalWon: u.totalWon,
            history: arrayUnion(...u.newHistory),
          });
        });
      });
      setPendingClose(null);
      showToast('Pari clôturé', 'success');
    } catch (e) {
      showToast('Erreur : ' + e.message, 'danger');
    }
  };

  const handleAddComment = async (betId, text) => {
    text = text.trim();
    if (!text) return;
    await updateDoc(doc(db, 'bets', betId), {
      comments: arrayUnion({ author: userDoc.pseudo, text, timestamp: Date.now() }),
    });
  };

  // ----- Rendu -----
  if (loading) return <div className="container"><p>Chargement…</p></div>;

  if (!authUser || !userDoc) {
    return <Login onSignup={handleSignup} onLogin={handleLogin} toast={toast} />;
  }

  return (
    <div className="container">
      {toast && <div className={`toast ${toast.type}`}>{toast.message}</div>}

      <div className="header-bar">
        <div className="user-info">
          <strong>{userDoc.pseudo}</strong>
          {isAdmin && <span className="admin-badge">admin</span>}
          <span className="stars-badge">⭐ {(userDoc.stars || 0).toLocaleString('fr-FR')}</span>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={handleRecharge}>+{RECHARGE_AMOUNT}</button>
          <button onClick={handleLogout}>Déconnexion</button>
        </div>
      </div>

      <div className="nav-tabs">
        <div className={`nav-tab ${activeTab === 'bets' ? 'active' : ''}`} onClick={() => setActiveTab('bets')}>Paris</div>
        <div className={`nav-tab ${activeTab === 'leaderboard' ? 'active' : ''}`} onClick={() => setActiveTab('leaderboard')}>Classement</div>
        <div className={`nav-tab ${activeTab === 'history' ? 'active' : ''}`} onClick={() => setActiveTab('history')}>Historique</div>
        {isAdmin && <div className={`nav-tab ${activeTab === 'create' ? 'active' : ''}`} onClick={() => setActiveTab('create')}>+ Créer</div>}
      </div>

      {activeTab === 'bets' && (
        bets.length === 0
          ? <div className="empty-state">Aucun pari pour l'instant.</div>
          : bets.map((bet) => (
            <BetCard
              key={bet.id}
              bet={bet}
              userDoc={userDoc}
              isAdmin={isAdmin}
              pendingClose={pendingClose}
              setPendingClose={setPendingClose}
              onPlaceBet={handlePlaceBet}
              onCloseBet={handleCloseBet}
              onAddComment={handleAddComment}
            />
          ))
      )}

      {activeTab === 'leaderboard' && <Leaderboard users={users} adminPseudo={adminPseudo} />}
      {activeTab === 'history' && <History user={userDoc} />}
      {activeTab === 'create' && isAdmin && <CreateBet onCreate={handleCreateBet} />}
    </div>
  );
}

function Login({ onSignup, onLogin, toast }) {
  const [mode, setMode] = useState('login');
  const [pseudo, setPseudo] = useState('');
  const [password, setPassword] = useState('');
  const submit = () => mode === 'login' ? onLogin(pseudo, password) : onSignup(pseudo, password);
  return (
    <div className="container">
      <div className="login-screen">
        <h1>Stars Bets</h1>
        <p className="subtitle">Paris entre amis. Le premier compte créé devient admin.</p>
        {toast && <div className={`toast ${toast.type}`}>{toast.message}</div>}
        <div className="form-group">
          <label className="form-label">Pseudo</label>
          <input value={pseudo} onChange={(e) => setPseudo(e.target.value)} placeholder="Ton pseudo" />
        </div>
        <div className="form-group">
          <label className="form-label">Mot de passe</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()} placeholder="••••••" />
        </div>
        <button className="primary" onClick={submit} style={{ width: '100%' }}>
          {mode === 'login' ? 'Se connecter' : 'Créer un compte'}
        </button>
        <div className="login-toggle">
          {mode === 'login'
            ? <>Pas encore de compte ? <button onClick={() => setMode('signup')}>Crée-en un</button></>
            : <>Déjà inscrit ? <button onClick={() => setMode('login')}>Connecte-toi</button></>}
        </div>
      </div>
    </div>
  );
}

function BetCard({ bet, userDoc, isAdmin, pendingClose, setPendingClose, onPlaceBet, onCloseBet, onAddComment }) {
  const [stakes, setStakes] = useState({});
  const [commentText, setCommentText] = useState('');
  const totalStake = bet.options.reduce((s, o) => s + (o.totalStake || 0), 0);
  const isClosed = bet.status === 'closed';
  const userMises = bet.options.flatMap((o) =>
    (o.bets || []).filter((b) => b.userId === userDoc.id).map((b) => ({ ...b, optionName: o.name }))
  );
  const pending = pendingClose && pendingClose.betId === bet.id;
  const pendingOpt = pending ? bet.options.find((o) => o.id === pendingClose.optionId) : null;

  return (
    <div className={`card ${isClosed ? 'closed' : ''}`}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <h3>{bet.title}</h3>
          {bet.description && <p className="bet-desc">{bet.description}</p>}
        </div>
        <span className={`status-badge ${isClosed ? 'status-closed' : 'status-open'}`}>
          {isClosed ? 'clôturé' : 'ouvert'}
        </span>
      </div>
      <div className="bet-meta">
        <span>Par {bet.createdBy}</span>
        <span>{formatDate(bet.createdAt)}</span>
        <span>{totalStake.toLocaleString('fr-FR')} stars en jeu</span>
      </div>

      {bet.options.map((opt) => {
        const coteEff = computeEffectiveCote(bet, opt.id);
        const isWinner = (bet.winningOptionIds || []).includes(opt.id);
        const share = totalStake > 0 ? ((opt.totalStake || 0) / totalStake * 100) : 0;
        const userBet = (opt.bets || []).find((b) => b.userId === userDoc.id);
        return (
          <div key={opt.id} className="option-row">
            <span className="option-name">
              {opt.name}
              {userBet && <span className="your-bet-tag">(toi: {userBet.amount}@{userBet.coteAtBet})</span>}
            </span>
            <span className="option-stat">{opt.totalStake || 0} stars · {share.toFixed(0)}%</span>
            <span className={`option-cote ${isClosed && isWinner ? 'winner' : ''}`}>
              {isClosed && isWinner ? '🏆 ' : ''}{coteEff.toFixed(2)}
            </span>
            {!isClosed && (
              <div className="stake-controls">
                <input
                  type="number"
                  min="1"
                  placeholder="Stars"
                  value={stakes[opt.id] || ''}
                  onChange={(e) => setStakes({ ...stakes, [opt.id]: e.target.value })}
                />
                <button onClick={() => {
                  const amt = parseInt(stakes[opt.id], 10);
                  if (isNaN(amt)) return;
                  onPlaceBet(bet.id, opt.id, amt);
                  setStakes({ ...stakes, [opt.id]: '' });
                }}>Miser</button>
              </div>
            )}
          </div>
        );
      })}

      {isAdmin && !isClosed && (
        <div style={{ marginTop: 12, paddingTop: 10, borderTop: '0.5px solid var(--border)' }}>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Clôturer (choisir le gagnant) :</p>
          {bet.options.map((opt) => (
            <span
              key={opt.id}
              className={`winner-pick ${pending && pendingClose.optionId === opt.id ? 'selected' : ''}`}
              onClick={() => setPendingClose({ betId: bet.id, optionId: opt.id })}
            >
              🏆 {opt.name}
            </span>
          ))}
          {pending && pendingOpt && (
            <div className="confirm-box">
              <p style={{ marginBottom: 8 }}>
                Désigner "<strong>{pendingOpt.name}</strong>" comme gagnant ?
              </p>
              <p style={{ fontSize: 12, marginBottom: 8 }}>
                {(pendingOpt.bets || []).length} parieur(s) · {pendingOpt.totalStake || 0} stars misées ·{' '}
                {(pendingOpt.bets || []).reduce((s, b) => s + Math.round(b.amount * b.coteAtBet), 0)} stars distribuées
              </p>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="primary" onClick={() => onCloseBet(bet.id, pendingOpt.id)}>Confirmer</button>
                <button onClick={() => setPendingClose(null)}>Annuler</button>
              </div>
            </div>
          )}
        </div>
      )}

      {userMises.length > 0 && (
        <div style={{ marginTop: 10, padding: '8px 10px', background: 'var(--accent-bg)', borderRadius: 'var(--radius)', fontSize: 12, color: 'var(--accent)' }}>
          Tu as misé : {userMises.map((m, i) => `${m.amount} sur "${m.optionName}" à ${m.coteAtBet}`).join(' · ')}
        </div>
      )}

      <div className="comments-section">
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
          Commentaires ({(bet.comments || []).length})
        </p>
        {(bet.comments || []).slice(-3).map((c, i) => (
          <div key={i} className="comment">
            <span className="comment-author">{c.author}:</span> {c.text}
          </div>
        ))}
        <div className="comment-input">
          <input
            placeholder="Ajouter un commentaire…"
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            style={{ flex: 1, fontSize: 12 }}
          />
          <button onClick={() => { onAddComment(bet.id, commentText); setCommentText(''); }}>OK</button>
        </div>
      </div>
    </div>
  );
}

function Leaderboard({ users, adminPseudo }) {
  const sorted = Object.values(users).sort((a, b) => (b.stars || 0) - (a.stars || 0));
  if (sorted.length === 0) return <div className="empty-state">Personne dans le classement</div>;
  return (
    <div className="card" style={{ padding: '4px 0' }}>
      {sorted.map((u, i) => (
        <div key={u.id} className="leaderboard-row">
          <span className="rank">{i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '#' + (i + 1)}</span>
          <span className="pseudo">
            {u.pseudo}
            {u.pseudo === adminPseudo && <span style={{ fontSize: 10, color: 'var(--text-faint)', marginLeft: 4 }}>admin</span>}
          </span>
          <span className="balance">{(u.stars || 0).toLocaleString('fr-FR')} stars · {u.wins || 0}W / {u.losses || 0}L</span>
        </div>
      ))}
    </div>
  );
}

function History({ user }) {
  const history = (user.history || []).slice().reverse();
  const stats = {
    bets: history.length,
    wins: history.filter((h) => h.result === 'win').length,
    netWon: user.totalWon || 0,
  };
  return (
    <>
      <div className="stat-grid">
        <div className="stat-card"><div className="stat-label">Paris joués</div><div className="stat-value">{stats.bets}</div></div>
        <div className="stat-card"><div className="stat-label">Victoires</div><div className="stat-value">{stats.wins}</div></div>
        <div className="stat-card"><div className="stat-label">Gain net</div><div className="stat-value">{stats.netWon >= 0 ? '+' : ''}{stats.netWon.toLocaleString('fr-FR')}</div></div>
      </div>
      {history.length === 0 ? <div className="empty-state">Aucun pari clôturé</div> : (
        <div className="card" style={{ padding: 0 }}>
          {history.map((h, i) => (
            <div key={i} className="history-item">
              <div>
                <div style={{ fontWeight: 500 }}>{h.betTitle}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{h.optionName} · mise {h.stake}</div>
              </div>
              <div className={h.result === 'win' ? 'result-win' : 'result-loss'}>
                {h.result === 'win' ? `+${(h.payout - h.stake).toLocaleString('fr-FR')}` : `-${h.stake}`}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function CreateBet({ onCreate }) {
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [options, setOptions] = useState([
    { name: '', coteBase: '2.0' },
    { name: '', coteBase: '2.0' },
  ]);

  const updateOption = (i, field, value) => {
    const next = [...options];
    next[i] = { ...next[i], [field]: value };
    setOptions(next);
  };

  const submit = () => {
    if (!title.trim()) return alert('Titre requis');
    const valid = options
      .filter((o) => o.name.trim() && parseFloat(o.coteBase) >= 1)
      .map((o) => ({ name: o.name.trim(), coteBase: parseFloat(o.coteBase) }));
    if (valid.length < 2) return alert('Au moins 2 options valides (cote ≥ 1)');
    onCreate({ title: title.trim(), description: desc.trim(), options: valid });
    setTitle(''); setDesc('');
    setOptions([{ name: '', coteBase: '2.0' }, { name: '', coteBase: '2.0' }]);
  };

  return (
    <div className="card">
      <h3 style={{ marginBottom: 12 }}>Nouveau pari</h3>
      <div className="form-group">
        <label className="form-label">Titre</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ex: Combien de fois Paul ira en boîte cette semaine ?" />
      </div>
      <div className="form-group">
        <label className="form-label">Description (optionnel)</label>
        <textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={2} style={{ resize: 'vertical' }} />
      </div>
      <div className="form-group">
        <label className="form-label">Options (avec cote de base)</label>
        {options.map((opt, i) => (
          <div key={i} className="options-builder">
            <input placeholder={`Option ${i + 1}`} value={opt.name} onChange={(e) => updateOption(i, 'name', e.target.value)} />
            <input className="cote-input" type="number" step="0.1" min="1" value={opt.coteBase} onChange={(e) => updateOption(i, 'coteBase', e.target.value)} />
          </div>
        ))}
        <button onClick={() => setOptions([...options, { name: '', coteBase: '2.0' }])} style={{ fontSize: 12, padding: '4px 10px' }}>
          + Ajouter une option
        </button>
        <p style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 6 }}>
          Cote de base × facteur dynamique entre {COTE_MIN_FACTOR} et {COTE_MAX_FACTOR}.
        </p>
      </div>
      <button className="primary" onClick={submit} style={{ width: '100%' }}>Créer le pari</button>
    </div>
  );
}
