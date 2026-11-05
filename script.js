import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { getFirestore, doc, setDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

// Suas credenciais do Firebase
const firebaseConfig = {
  apiKey: "AIzaSyAxYiheIatkdsSk0BUSaOlFEd6NZP9ew7w",
  authDomain: "financontrol-pro-bd917.firebaseapp.com",
  projectId: "financontrol-pro-bd917",
  storageBucket: "financontrol-pro-bd917.firebasestorage.app",
  messagingSenderId: "1066390425961",
  appId: "1:1066390425961:web:7094128421d5cdf9f02df8"
};

// ---------------------------------------------------------
// 1. TABELAS REGRESSIVAS OFICIAIS DO BRASIL (IOF & IR)
// ---------------------------------------------------------
const IOF_TABLE = [
    100, 96, 93, 90, 86, 83, 80, 76, 73, 70,
    66, 63, 60, 56, 53, 50, 46, 43, 40, 36,
    33, 30, 26, 23, 20, 16, 13, 10, 6, 3
];

function getIofRatePercent(daysElapsed) {
    if (daysElapsed < 0) return 0;
    if (daysElapsed >= 30) return 0;
    return IOF_TABLE[Math.floor(daysElapsed)] ?? 0;
}

function getIrRatePercent(daysElapsed) {
    if (daysElapsed <= 180) return 22.5;
    if (daysElapsed <= 360) return 20.0;
    if (daysElapsed <= 720) return 17.5;
    return 15.0;
}

function calculateInvestmentDetails(principal, startDateStr, simDateStr, cdiPercent, annualCdiRate, taxType) {
    const p = Number(principal) || 0;
    const start = new Date(startDateStr + "T00:00:00");
    const end = new Date(simDateStr + "T00:00:00");
    const diffMs = end - start;
    const calendarDays = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));

    const businessDays = Math.max(0, Math.round(calendarDays * (252 / 365)));
    const effectiveAnnualRate = (Number(annualCdiRate) / 100) * (Number(cdiPercent) / 100);
    const dailyFactor = Math.pow(1 + effectiveAnnualRate, 1 / 252);

    const grossTotal = p * Math.pow(dailyFactor, businessDays);
    const grossYield = Math.max(0, grossTotal - p);

    const isExempt = taxType === 'exempt';
    const iofPercent = isExempt ? 0 : getIofRatePercent(calendarDays);
    const irPercent = isExempt ? 0 : getIrRatePercent(calendarDays);

    const iofAmount = grossYield * (iofPercent / 100);
    const yieldAfterIof = Math.max(0, grossYield - iofAmount);
    const irAmount = yieldAfterIof * (irPercent / 100);

    const netYieldWithIof = Math.max(0, grossYield - iofAmount - irAmount);
    const netTotalWithIof = p + netYieldWithIof;

    const irWithoutIof = grossYield * (irPercent / 100);
    const netYieldWithoutIof = Math.max(0, grossYield - irWithoutIof);
    const netTotalWithoutIof = p + netYieldWithoutIof;

    const gross1y = p * Math.pow(dailyFactor, 252) - p;
    const net1y = p + (isExempt ? gross1y : gross1y * (1 - 0.175));

    return {
        principal: p,
        calendarDays,
        businessDays,
        grossYield,
        grossTotal,
        iofPercent,
        iofAmount,
        irPercent,
        irAmount,
        netYieldWithIof,
        netTotalWithIof,
        netYieldWithoutIof,
        netTotalWithoutIof,
        net1y,
        daysRemainingForZeroIof: Math.max(0, 30 - calendarDays)
    };
}

// ---------------------------------------------------------
// 2. ESTADO DA APLICAÇÃO & FIREBASE / SYNC
// ---------------------------------------------------------
let appState = {
    activeProfileId: null,
    globalCdiRate: 11.15,
    profiles: [],
    transactions: [],
    vaults: []
};

let currentTab = 'flow';
const now = new Date();
let viewYear = now.getFullYear();
let viewMonth = now.getMonth();
let useCustomDateRange = false;
let customStartDate = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-01`;
let customEndDate = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-28`;
let pendingPinProfileId = null;
let pendingDeleteTx = null;

const FLOW_CATEGORIES = {
    income: ['Salário / Estágio', 'Freelas & Projetos', 'Rendimentos Extras', 'Reembolsos / Aluguéis', '13º / Férias / Bônus', 'Outras Entradas'],
    fixed: ['Moradia / Condomínio / IPTU', 'Luz, Água & Gás', 'Internet & Celular', 'Saúde & Remédios Fixos', 'Educação & Cursos', 'Seguro / IPVA / Taxas', 'Outras Contas Fixas'],
    sporadic: ['Supermercado & Padaria (PIX/Débito)', 'Combustível & Manutenção', 'Delivery, Lanches & Saídas', 'Farmácia & Saúde Avulsa', 'Pets & Casa', 'Presentes & Vestuário', 'Imprevistos & Outros']
};

let db = null;
let auth = null;
let currentUser = null;
const docPath = "financontrol/mainUserData"; // Caminho direto no seu Firestore

async function initPersistence() {
    const badge = document.getElementById('syncStatusBadge');
    try {
        const app = initializeApp(firebaseConfig);
        auth = getAuth(app);
        db = getFirestore(app);

        await signInAnonymously(auth);
        currentUser = auth.currentUser;

        if (currentUser) {
            const stateDocRef = doc(db, docPath);
            onSnapshot(stateDocRef, (snapshot) => {
                if (snapshot.exists()) {
                    const cloudData = snapshot.data();
                    if (cloudData && Array.isArray(cloudData.profiles)) {
                        appState = {
                            activeProfileId: cloudData.activeProfileId || (cloudData.profiles[0]?.id ?? null),
                            globalCdiRate: cloudData.globalCdiRate || 11.15,
                            profiles: cloudData.profiles || [],
                            transactions: cloudData.transactions || [],
                            vaults: cloudData.vaults || []
                        };
                        document.getElementById('globalCdiRate').value = appState.globalCdiRate;
                        renderAll();
                        checkOnboardingState();
                    }
                } else {
                    checkOnboardingState();
                }
                badge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span> Sincronizado`;
            }, (err) => {
                console.warn("Aviso no listener Firestore:", err);
                checkOnboardingState();
            });
        }
    } catch (e) {
        console.warn("Erro ao conectar ao Firebase:", e);
        checkOnboardingState();
    }
}

async function saveStateToCloud() {
    renderAll();
    if (db) {
        try {
            const stateDocRef = doc(db, docPath);
            await setDoc(stateDocRef, JSON.parse(JSON.stringify(appState)));
        } catch (err) {
            console.warn("Erro ao sincronizar com o Firebase:", err);
        }
    }
}

// ---------------------------------------------------------
// 3. UTILITÁRIOS E FORMATAÇÃO
// ---------------------------------------------------------
function formatBRL(val) {
    const num = Number(val) || 0;
    return num.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatDateBR(dateStr) {
    if (!dateStr) return '';
    const parts = dateStr.split('-');
    if (parts.length !== 3) return dateStr;
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

function getMonthNamePT(year, monthIndex) {
    const d = new Date(year, monthIndex, 1);
    return d.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
}

function addMonthsToDateStr(dateStr, monthsToAdd) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const targetMonthIndex = (m - 1) + monthsToAdd;
    const targetDate = new Date(y, targetMonthIndex, 1);
    const maxDaysInMonth = new Date(targetDate.getFullYear(), targetDate.getMonth() + 1, 0).getDate();
    const safeDay = Math.min(d, maxDaysInMonth);
    const finalYear = targetDate.getFullYear();
    const finalMonth = String(targetDate.getMonth() + 1).padStart(2, '0');
    const finalDay = String(safeDay).padStart(2, '0');
    return `${finalYear}-${finalMonth}-${finalDay}`;
}

function isDateInActivePeriod(dateStr) {
    if (!dateStr) return false;
    if (useCustomDateRange) {
        return dateStr >= customStartDate && dateStr <= customEndDate;
    } else {
        const [y, m] = dateStr.split('-').map(Number);
        return y === viewYear && (m - 1) === viewMonth;
    }
}

function showToast(msg) {
    const toast = document.getElementById('toastNotification');
    if (!toast) return;
    document.getElementById('toastMessage').textContent = msg;
    toast.classList.remove('opacity-0', 'pointer-events-none', 'translate-y-3');
    setTimeout(() => {
        toast.classList.add('opacity-0', 'pointer-events-none', 'translate-y-3');
    }, 2600);
}

// ---------------------------------------------------------
// 4. PERFIS MULTI-USUÁRIO
// ---------------------------------------------------------
function getActiveProfile() {
    if (!appState.profiles || appState.profiles.length === 0) return null;
    return appState.profiles.find(p => p.id === appState.activeProfileId) || appState.profiles[0];
}

function checkOnboardingState() {
    const modal = document.getElementById('profileLoginModal');
    const closeBtn = document.getElementById('closeProfileModalBtn');
    const newForm = document.getElementById('newProfileForm');
    const title = document.getElementById('profileModalTitle');
    const sub = document.getElementById('profileModalSubtitle');

    if (!modal) return;

    if (!appState.profiles || appState.profiles.length === 0) {
        title.textContent = 'Bem-vindo ao FinanControl Pro';
        sub.textContent = 'Crie o seu primeiro perfil abaixo para começar a registrar seus ganhos, contas, cartões e cofrinhos.';
        closeBtn.classList.add('hidden');
        newForm.classList.remove('hidden');
        modal.classList.remove('hidden');
        renderProfileModalCards();
        setTimeout(() => document.getElementById('newProfName')?.focus(), 100);
    } else {
        title.textContent = 'Alternar ou Criar Perfil';
        sub.textContent = 'Cada perfil possui seus próprios lançamentos, cartões e cofrinhos separados.';
        closeBtn.classList.remove('hidden');
    }
}

function getColorClasses(color) {
    const map = {
        emerald: { dot: 'bg-emerald-500', activeBtn: 'bg-emerald-500 text-white shadow-sm', border: 'border-emerald-500/40' },
        purple:  { dot: 'bg-purple-500',  activeBtn: 'bg-purple-600 text-white shadow-sm',  border: 'border-purple-500/40' },
        amber:   { dot: 'bg-amber-500',   activeBtn: 'bg-amber-500 text-white shadow-sm',   border: 'border-amber-500/40' },
        blue:    { dot: 'bg-blue-500',    activeBtn: 'bg-blue-600 text-white shadow-sm',    border: 'border-blue-500/40' },
        rose:    { dot: 'bg-rose-500',    activeBtn: 'bg-rose-500 text-white shadow-sm',    border: 'border-rose-500/40' }
    };
    return map[color] || map.emerald;
}

window.requestProfileSwitch = function(profileId) {
    const target = appState.profiles.find(p => p.id === profileId);
    if (!target) return;
    if (target.pin && target.pin.trim() !== '' && target.id !== appState.activeProfileId) {
        pendingPinProfileId = target.id;
        document.getElementById('profileLoginModal').classList.remove('hidden');
        document.getElementById('pinVerifyBox').classList.remove('hidden');
        document.getElementById('pinVerifyTitle').textContent = `Digite o PIN para acessar: ${target.name}`;
        document.getElementById('pinVerifyInput').value = '';
        document.getElementById('pinErrorMsg').classList.add('hidden');
        renderProfileModalCards();
        setTimeout(() => document.getElementById('pinVerifyInput').focus(), 80);
    } else {
        appState.activeProfileId = target.id;
        document.getElementById('profileLoginModal').classList.add('hidden');
        document.getElementById('pinVerifyBox').classList.add('hidden');
        saveStateToCloud();
        showToast(`Perfil ativo: ${target.name}`);
    }
};

window.deleteProfileById = function(event, profileId) {
    event.stopPropagation();
    appState.profiles = appState.profiles.filter(p => p.id !== profileId);
    appState.transactions = appState.transactions.filter(t => t.profileId !== profileId);
    appState.vaults = appState.vaults.filter(v => v.profileId !== profileId);

    if (appState.activeProfileId === profileId) {
        appState.activeProfileId = appState.profiles[0]?.id ?? null;
    }
    saveStateToCloud();
    renderProfileModalCards();
    checkOnboardingState();
    showToast('Perfil removido.');
};

function renderProfileSwitcherAndBanner() {
    const switcher = document.getElementById('quickProfileSwitcher');
    const activeProf = getActiveProfile();

    if (!activeProf) {
        switcher.innerHTML = `<span class="text-xs text-slate-400 px-2 py-1">Crie seu perfil</span>`;
        document.getElementById('activeProfileNameBanner').textContent = 'Aguardando criação de perfil';
        return;
    }

    const activeColors = getColorClasses(activeProf.color);

    switcher.innerHTML = appState.profiles.map(prof => {
        const isCurrent = prof.id === activeProf.id;
        const c = getColorClasses(prof.color);
        return `
            <button onclick="requestProfileSwitch('${prof.id}')"
                class="px-3 py-1.5 rounded-xl text-xs font-bold flex items-center gap-1.5 transition ${isCurrent ? c.activeBtn : 'text-slate-600 dark:text-slate-400 hover:bg-white/60 dark:hover:bg-slate-800'}">
                <span class="w-2 h-2 rounded-full ${isCurrent ? 'bg-white' : c.dot}"></span>
                <span>${prof.name}</span>
                ${prof.pin ? '<i data-lucide="lock" class="w-3 h-3 opacity-75"></i>' : ''}
            </button>
        `;
    }).join('');

    document.getElementById('activeProfileNameBanner').textContent = activeProf.name;
    document.getElementById('activeProfileDot').className = `w-3 h-3 rounded-full ${activeColors.dot} ring-4 ring-emerald-500/20`;

    const periodText = useCustomDateRange
        ? `${formatDateBR(customStartDate)} até ${formatDateBR(customEndDate)}`
        : getMonthNamePT(viewYear, viewMonth);
    document.getElementById('activePeriodBanner').textContent = periodText;
    document.getElementById('currentMonthLabel').textContent = getMonthNamePT(viewYear, viewMonth);
    document.getElementById('invoiceMonthBadge').textContent = periodText;
}

function renderProfileModalCards() {
    const grid = document.getElementById('profileCardsGrid');
    if (!appState.profiles || appState.profiles.length === 0) {
        grid.innerHTML = `
            <div class="col-span-full p-4 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 text-center text-xs text-emerald-600 dark:text-emerald-300 font-semibold">
                Nenhum perfil cadastrado ainda. Preencha o nome abaixo para criar o seu primeiro acesso!
            </div>
        `;
        return;
    }

    grid.innerHTML = appState.profiles.map(prof => {
        const isCurrent = prof.id === appState.activeProfileId;
        const c = getColorClasses(prof.color);
        const countTx = appState.transactions.filter(t => t.profileId === prof.id).length;
        const countVaults = appState.vaults.filter(v => v.profileId === prof.id).length;
        return `
            <div onclick="requestProfileSwitch('${prof.id}')"
                class="p-4 rounded-2xl border-2 cursor-pointer transition flex flex-col justify-between ${isCurrent ? 'border-emerald-500 bg-emerald-500/10' : 'border-slate-200 dark:border-slate-800 hover:border-slate-400 dark:hover:border-slate-600 bg-slate-50 dark:bg-slate-800/40'}">
                <div>
                    <div class="flex items-center justify-between mb-2">
                        <span class="w-3.5 h-3.5 rounded-full ${c.dot}"></span>
                        <div class="flex items-center gap-1.5">
                            ${prof.pin ? '<span class="text-[10px] px-2 py-0.5 rounded-full bg-slate-200 dark:bg-slate-700 font-bold">🔒 PIN</span>' : '<span class="text-[10px] text-slate-400">Livre</span>'}
                            <button type="button" onclick="deleteProfileById(event, '${prof.id}')" class="p-1 rounded-lg text-slate-400 hover:text-rose-500 hover:bg-rose-500/10 transition" title="Excluir Perfil">
                                <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
                            </button>
                        </div>
                    </div>
                    <h4 class="font-extrabold text-base truncate">${prof.name}</h4>
                    <p class="text-[11px] text-slate-500 dark:text-slate-400 mt-1">${countTx} lançamentos • ${countVaults} cofrinhos</p>
                </div>
                <div class="mt-4 pt-2 border-t border-slate-200/60 dark:border-slate-700/60 flex items-center justify-between text-xs font-bold text-emerald-500">
                    <span>${isCurrent ? 'Em uso agora' : 'Entrar nesta conta'}</span>
                    <span>→</span>
                </div>
            </div>
        `;
    }).join('');
    if (window.lucide) window.lucide.createIcons();
}

// ---------------------------------------------------------
// 5. ABA 1: FLUXO DO MÊS
// ---------------------------------------------------------
function renderKPIsAndFlow() {
    const profId = appState.activeProfileId;
    const profTxs = appState.transactions.filter(t => t.profileId === profId);
    const periodTxs = profTxs.filter(t => isDateInActivePeriod(t.date));

    const incomes = periodTxs.filter(t => t.type === 'income');
    const totalIncome = incomes.reduce((acc, t) => acc + Number(t.amount || 0), 0);

    const fixedList = periodTxs.filter(t => t.type === 'fixed');
    const totalFixed = fixedList.reduce((acc, t) => acc + Number(t.amount || 0), 0);
    const fixedPaid = fixedList.filter(t => t.paid).reduce((acc, t) => acc + Number(t.amount || 0), 0);
    const fixedPending = Math.max(0, totalFixed - fixedPaid);

    const sporadicList = periodTxs.filter(t => t.type === 'sporadic');
    const totalSporadic = sporadicList.reduce((acc, t) => acc + Number(t.amount || 0), 0);

    const cardItems = getCreditCardItemsForActivePeriod(profTxs);
    const totalCard = cardItems.reduce((acc, t) => acc + Number(t.amount || 0), 0);

    const cdiRate = Number(document.getElementById('globalCdiRate').value) || 11.15;
    const simDate = document.getElementById('globalSimDate').value || '2026-11-04';
    const profVaults = appState.vaults.filter(v => v.profileId === profId);
    const totalVaultNet = profVaults.reduce((acc, v) => {
        const calc = calculateInvestmentDetails(v.principal, v.startDate, simDate, v.cdiPercent, cdiRate, v.taxType);
        return acc + calc.netTotalWithIof;
    }, 0);

    const totalAllOutflows = totalFixed + totalSporadic + totalCard;
    const netBalance = totalIncome - totalAllOutflows;
    const commitPct = totalIncome > 0 ? Math.min(100, Math.round((totalAllOutflows / totalIncome) * 100)) : 0;

    document.getElementById('kpiIncome').textContent = formatBRL(totalIncome);
    document.getElementById('kpiIncomeCount').textContent = `${incomes.length} entrada(s) no período`;

    document.getElementById('kpiFixed').textContent = formatBRL(totalFixed);
    document.getElementById('kpiFixedSub').textContent = `Pago: ${formatBRL(fixedPaid)} | Pend: ${formatBRL(fixedPending)}`;

    document.getElementById('kpiSporadic').textContent = formatBRL(totalSporadic);
    document.getElementById('kpiSporadicSub').textContent = `${sporadicList.length} gasto(s) no PIX/Déb`;

    document.getElementById('kpiCard').textContent = formatBRL(totalCard);
    document.getElementById('kpiCardSub').textContent = `${cardItems.length} compra(s) na fatura`;
    document.getElementById('navCardCountBadge').textContent = cardItems.length;

    const netEl = document.getElementById('kpiNetBalance');
    netEl.textContent = formatBRL(netBalance);
    netEl.className = `text-xl font-extrabold mt-2 ${netBalance >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500'}`;
    document.getElementById('kpiVaultTotal').textContent = `Cofrinhos: ${formatBRL(totalVaultNet)}`;
    document.getElementById('kpiCommitBadge').textContent = `${commitPct}% da renda`;

    document.getElementById('listTotalIncome').textContent = formatBRL(totalIncome);
    document.getElementById('listTotalFixed').textContent = formatBRL(totalFixed);
    document.getElementById('listTotalSporadic').textContent = formatBRL(totalSporadic);

    renderFlowList('incomeListContainer', incomes, 'emerald', 'Nenhum rendimento cadastrado neste período.');
    renderFlowList('fixedListContainer', fixedList, 'blue', 'Nenhuma conta fixa lançada neste período.');
    renderFlowList('sporadicListContainer', sporadicList, 'cyan', 'Nenhum gasto esporádico registrado neste período.');
}

function renderFlowList(containerId, items, colorName, emptyMsg) {
    const container = document.getElementById(containerId);
    if (items.length === 0) {
        container.innerHTML = `<p class="text-xs text-slate-400 py-4 text-center">${emptyMsg}</p>`;
        return;
    }
    const sorted = [...items].sort((a, b) => b.date.localeCompare(a.date));
    container.innerHTML = sorted.map(item => `
        <div class="py-3 flex items-center justify-between gap-3 group">
            <div class="flex items-center gap-3 min-w-0">
                <button onclick="toggleFlowPaid('${item.id}')" title="Alternar Pago / Pendente"
                    class="w-6 h-6 rounded-lg border flex items-center justify-center shrink-0 transition ${item.paid ? 'bg-emerald-500 border-emerald-500 text-white' : 'border-slate-300 dark:border-slate-700 text-transparent hover:border-emerald-500'}">
                    <i data-lucide="check" class="w-3.5 h-3.5"></i>
                </button>
                <div class="min-w-0">
                    <div class="flex items-center gap-2 flex-wrap">
                        <p class="text-xs sm:text-sm font-bold truncate ${!item.paid && item.type !== 'income' ? 'text-amber-500' : ''}">${item.desc}</p>
                        <span class="text-[10px] px-2 py-0.5 rounded-full bg-slate-200/80 dark:bg-slate-800 text-slate-600 dark:text-slate-300 font-semibold">${item.category}</span>
                        ${!item.paid ? '<span class="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-500 font-bold">Pendente</span>' : ''}
                    </div>
                    <p class="text-[11px] text-slate-400 mt-0.5">${formatDateBR(item.date)}</p>
                </div>
            </div>
            <div class="flex items-center gap-3 shrink-0">
                <span class="text-xs sm:text-sm font-extrabold ${item.type === 'income' ? 'text-emerald-500' : 'text-slate-800 dark:text-slate-100'}">
                    ${item.type === 'income' ? '+' : '-'} ${formatBRL(item.amount)}
                </span>
                <button onclick="deleteTransaction('${item.id}')" class="p-1.5 rounded-lg text-slate-400 hover:text-rose-500 hover:bg-rose-500/10 transition" title="Excluir">
                    <i data-lucide="trash-2" class="w-4 h-4"></i>
                </button>
            </div>
        </div>
    `).join('');
}

window.toggleFlowPaid = function(txId) {
    const tx = appState.transactions.find(t => t.id === txId);
    if (tx) {
        tx.paid = !tx.paid;
        saveStateToCloud();
    }
};

// ---------------------------------------------------------
// 6. ABA 2: CARTÃO DE CRÉDITO
// ---------------------------------------------------------
function getCreditCardItemsForActivePeriod(profTxs) {
    const allCardTxs = profTxs.filter(t => t.type === 'credit_card');
    const directMatches = allCardTxs.filter(t => isDateInActivePeriod(t.date));

    if (!useCustomDateRange) {
        const recurringTxs = allCardTxs.filter(t => t.isRecurring);
        recurringTxs.forEach(rec => {
            const [ry, rm] = rec.date.split('-').map(Number);
            const recMonthIndex = ry * 12 + (rm - 1);
            const currentViewIndex = viewYear * 12 + viewMonth;
            const alreadyInDirect = directMatches.some(d => d.id === rec.id || (d.groupId && d.groupId === rec.groupId));
            if (currentViewIndex > recMonthIndex && !alreadyInDirect) {
                directMatches.push({ ...rec, virtualRecurring: true });
            }
        });
    }
    return directMatches;
}

function renderCreditCardTab() {
    const profId = appState.activeProfileId;
    const profTxs = appState.transactions.filter(t => t.profileId === profId);
    const selectedBank = document.getElementById('filterCardBank').value;

    const futureGrid = document.getElementById('futureInvoicesGrid');
    const futureCardsHTML = [];
    for (let offset = 0; offset < 6; offset++) {
        const d = new Date(viewYear, viewMonth + offset, 1);
        const y = d.getFullYear();
        const m = d.getMonth();

        const monthItems = profTxs.filter(t => {
            if (t.type !== 'credit_card') return false;
            if (selectedBank !== 'ALL' && t.cardName !== selectedBank) return false;
            const [ty, tm] = t.date.split('-').map(Number);
            if (t.isRecurring) {
                return (y * 12 + m) >= (ty * 12 + (tm - 1));
            }
            return ty === y && (tm - 1) === m;
        });

        const sum = monthItems.reduce((acc, i) => acc + Number(i.amount || 0), 0);
        const isSelected = (!useCustomDateRange && y === viewYear && m === viewMonth);
        const shortLabel = d.toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' }).replace('.', '');

        futureCardsHTML.push(`
            <div onclick="jumpToMonth(${y}, ${m})"
                class="p-3 rounded-xl border cursor-pointer transition ${isSelected ? 'border-orange-500 bg-orange-500/15' : 'border-slate-200 dark:border-slate-800 bg-white/50 dark:bg-slate-900/60 hover:border-orange-500/50'}">
                <div class="flex items-center justify-between text-[11px]">
                    <span class="font-bold uppercase ${isSelected ? 'text-orange-500' : 'text-slate-400'}">${shortLabel}</span>
                    <span class="text-[10px] text-slate-400">${monthItems.length} itens</span>
                </div>
                <p class="text-sm font-extrabold mt-1 ${sum > 0 ? 'text-slate-900 dark:text-white' : 'text-slate-400'}">${formatBRL(sum)}</p>
            </div>
        `);
    }
    futureGrid.innerHTML = futureCardsHTML.join('');

    let items = getCreditCardItemsForActivePeriod(profTxs);
    if (selectedBank !== 'ALL') {
        items = items.filter(i => i.cardName === selectedBank);
    }

    let sumSingle = 0;
    let sumInstallments = 0;
    items.forEach(i => {
        if ((i.totalInstallments || 1) > 1) {
            sumInstallments += Number(i.amount || 0);
        } else {
            sumSingle += Number(i.amount || 0);
        }
    });

    document.getElementById('cardSummarySingle').textContent = formatBRL(sumSingle);
    document.getElementById('cardSummaryInstallments').textContent = formatBRL(sumInstallments);
    document.getElementById('cardSummaryTotal').textContent = formatBRL(sumSingle + sumInstallments);

    const listEl = document.getElementById('cardItemsListContainer');
    if (items.length === 0) {
        listEl.innerHTML = `
            <div class="py-10 text-center text-slate-400">
                <p class="text-sm font-semibold">Nenhuma compra no cartão para este período.</p>
                <p class="text-xs mt-1">Use o formulário ao lado para detalhar suas compras à vista, parceladas ou assinaturas.</p>
            </div>
        `;
        return;
    }

    const sorted = [...items].sort((a, b) => b.date.localeCompare(a.date));
    listEl.innerHTML = sorted.map(item => {
        const instNum = Number(item.installmentNumber) || 1;
        const totalInst = Number(item.totalInstallments) || 1;
        const remainingInstallments = Math.max(0, totalInst - instNum);
        const remainingValue = remainingInstallments * Number(item.amount || 0);

        let badgeHTML = '';
        if (item.isRecurring) {
            badgeHTML = `<span class="px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-purple-500/15 text-purple-400 border border-purple-500/30">🔄 Assinatura Mensal</span>`;
        } else if (totalInst > 1) {
            badgeHTML = `<span class="px-2.5 py-0.5 rounded-full text-[11px] font-extrabold bg-orange-500/20 text-orange-500 border border-orange-500/30">Parcela ${instNum}/${totalInst}</span>`;
        } else {
            badgeHTML = `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/15 text-emerald-500">À vista (1x)</span>`;
        }

        return `
            <div class="py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div class="space-y-1">
                    <div class="flex items-center gap-2 flex-wrap">
                        <span class="text-xs font-extrabold px-2 py-0.5 rounded-md bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-200">${item.cardName || 'Cartão'}</span>
                        <h4 class="text-sm font-bold text-slate-900 dark:text-white">${item.desc}</h4>
                        ${badgeHTML}
                        <span class="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800/80 text-slate-500">${item.category}</span>
                    </div>
                    <div class="flex items-center gap-3 text-[11px] text-slate-400">
                        <span>Compra/Venc: ${formatDateBR(item.date)}</span>
                        ${totalInst > 1 ? `<span>• Total: <strong>${formatBRL(item.totalPurchaseAmount || (item.amount * totalInst))}</strong></span>` : ''}
                        ${remainingInstallments > 0 ? `<span class="text-orange-400 font-semibold">• Faltam ${remainingInstallments}x (${formatBRL(remainingValue)})</span>` : ''}
                    </div>
                </div>
                <div class="flex items-center justify-between sm:justify-end gap-3 pt-1 sm:pt-0 border-t sm:border-t-0 border-slate-200/50 dark:border-slate-800">
                    <div class="text-right">
                        <span class="text-[10px] text-slate-400 block">Nesta fatura</span>
                        <strong class="text-sm font-extrabold text-orange-500">${formatBRL(item.amount)}</strong>
                    </div>
                    <button onclick="deleteTransaction('${item.id}')" class="p-2 rounded-xl text-slate-400 hover:text-rose-500 hover:bg-rose-500/10 transition" title="Excluir">
                        <i data-lucide="trash-2" class="w-4 h-4"></i>
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

window.jumpToMonth = function(y, m) {
    useCustomDateRange = false;
    document.getElementById('customRangeInputs').classList.add('hidden');
    document.getElementById('monthModeSelector').classList.remove('hidden');
    viewYear = y;
    viewMonth = m;
    renderAll();
};

// ---------------------------------------------------------
// 7. ABA 3: COFRINHOS & INVESTIMENTOS
// ---------------------------------------------------------
function renderInvestmentsTab() {
    const profId = appState.activeProfileId;
    const profVaults = appState.vaults.filter(v => v.profileId === profId);
    const cdiRate = Number(document.getElementById('globalCdiRate').value) || 11.15;
    const simDate = document.getElementById('globalSimDate').value || '2026-11-04';

    let sumPrincipal = 0;
    let sumGrossYield = 0;
    let sumTaxes = 0;
    let sumNetTotal = 0;

    const container = document.getElementById('vaultsListContainer');

    if (profVaults.length === 0) {
        container.innerHTML = `
            <div class="glass-card rounded-2xl p-8 text-center border border-slate-200 dark:border-slate-800">
                <p class="text-sm font-bold text-slate-400">Nenhum Cofrinho ou CDB cadastrado neste perfil ainda.</p>
                <p class="text-xs text-slate-500 mt-1">Cadastre no formulário ao lado para acompanhar o rendimento diário com cálculo real de IOF e IR.</p>
            </div>
        `;
    } else {
        container.innerHTML = profVaults.map(vault => {
            const calc = calculateInvestmentDetails(vault.principal, vault.startDate, simDate, vault.cdiPercent, cdiRate, vault.taxType);
            sumPrincipal += calc.principal;
            sumGrossYield += calc.grossYield;
            sumTaxes += (calc.iofAmount + calc.irAmount);
            sumNetTotal += calc.netTotalWithIof;

            const iofProgressPct = Math.min(100, Math.round((calc.calendarDays / 30) * 100));

            return `
                <div class="glass-card rounded-2xl p-5 border border-slate-200 dark:border-slate-800 shadow-sm space-y-4">
                    <div class="flex flex-wrap items-start justify-between gap-2">
                        <div>
                            <div class="flex items-center gap-2 flex-wrap">
                                <h4 class="font-extrabold text-base text-slate-900 dark:text-white">${vault.name}</h4>
                                <span class="px-2.5 py-0.5 rounded-full text-[11px] font-extrabold bg-purple-500/15 text-purple-400 border border-purple-500/30">${vault.cdiPercent}% do CDI</span>
                                <span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${vault.taxType === 'exempt' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-slate-200 dark:bg-slate-800 text-slate-500'}">${vault.taxType === 'exempt' ? 'Isento IOF/IR' : `IR Atual: ${calc.irPercent.toFixed(1)}%`}</span>
                            </div>
                            <p class="text-xs text-slate-500 dark:text-slate-400 mt-1">Aplicado em <strong>${formatDateBR(vault.startDate)}</strong> • <strong>${calc.calendarDays} dias corridos</strong> (${calc.businessDays} dias úteis)</p>
                        </div>
                        <button onclick="deleteVault('${vault.id}')" class="p-2 rounded-xl text-slate-400 hover:text-rose-500 hover:bg-rose-500/10 transition" title="Remover">
                            <i data-lucide="trash-2" class="w-4 h-4"></i>
                        </button>
                    </div>

                    ${vault.taxType !== 'exempt' ? `
                        <div class="p-3 rounded-xl ${calc.daysRemainingForZeroIof > 0 ? 'bg-amber-500/10 border border-amber-500/25' : 'bg-emerald-500/10 border border-emerald-500/25'}">
                            <div class="flex items-center justify-between text-xs mb-1.5">
                                <span class="font-bold ${calc.daysRemainingForZeroIof > 0 ? 'text-amber-500' : 'text-emerald-500'}">
                                    ${calc.daysRemainingForZeroIof > 0 ? `⏳ IOF Regressivo (${calc.iofPercent}% hoje) • Faltam ${calc.daysRemainingForZeroIof} dias para zerar` : `✅ Isento de IOF (Mais de 30 dias)`}
                                </span>
                                <span class="font-extrabold text-[11px]">${Math.min(30, calc.calendarDays)}/30 dias</span>
                            </div>
                            <div class="w-full h-2 bg-slate-200 dark:bg-slate-800 rounded-full overflow-hidden">
                                <div class="h-full ${calc.daysRemainingForZeroIof > 0 ? 'bg-amber-500' : 'bg-emerald-500'} transition-all duration-500" style="width: ${iofProgressPct}%"></div>
                            </div>
                        </div>
                    ` : ''}

                    <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <div class="p-3.5 rounded-xl bg-slate-100/80 dark:bg-slate-900/70 border border-slate-200/60 dark:border-slate-800">
                            <span class="text-[11px] text-slate-400 block">Bruto</span>
                            <strong class="text-sm font-extrabold block mt-0.5">${formatBRL(calc.grossTotal)}</strong>
                            <span class="text-[11px] text-emerald-500 font-semibold">Lucro: +${formatBRL(calc.grossYield)}</span>
                        </div>
                        <div class="p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30">
                            <span class="text-[11px] font-bold text-emerald-600 dark:text-emerald-400 block">Líquido Hoje (Com IOF + IR)</span>
                            <strong class="text-base font-extrabold text-emerald-600 dark:text-emerald-400 block mt-0.5">${formatBRL(calc.netTotalWithIof)}</strong>
                            <span class="text-[11px] text-slate-500 dark:text-slate-300">Lucro: <strong>+${formatBRL(calc.netYieldWithIof)}</strong></span>
                        </div>
                        <div class="p-3.5 rounded-xl bg-purple-500/10 border border-purple-500/25">
                            <span class="text-[11px] font-bold text-purple-400 block">Sem IOF (Só IR)</span>
                            <strong class="text-base font-extrabold text-purple-400 block mt-0.5">${formatBRL(calc.netTotalWithoutIof)}</strong>
                            <span class="text-[11px] text-slate-500 dark:text-slate-300">Projeção 1 ano: <strong>${formatBRL(calc.net1y)}</strong></span>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    }

    document.getElementById('vaultSumPrincipal').textContent = formatBRL(sumPrincipal);
    document.getElementById('vaultSumGrossYield').textContent = `+ ${formatBRL(sumGrossYield)}`;
    document.getElementById('vaultSumTaxes').textContent = `- ${formatBRL(sumTaxes)}`;
    document.getElementById('vaultSumNetTotal').textContent = formatBRL(sumNetTotal);

    updateLiveVaultFormPreview();
}

function updateLiveVaultFormPreview() {
    const p = Number(document.getElementById('vaultPrincipal').value) || 1000;
    const start = document.getElementById('vaultStartDate').value || '2026-10-20';
    const sim = document.getElementById('globalSimDate').value || '2026-11-04';
    const cdiPct = Number(document.getElementById('vaultCdiPercent').value) || 100;
    const cdiRate = Number(document.getElementById('globalCdiRate').value) || 11.15;
    const taxType = document.getElementById('vaultTaxType').value;

    const calc = calculateInvestmentDetails(p, start, sim, cdiPct, cdiRate, taxType);
    document.getElementById('vaultLivePreviewText').innerHTML = `
        Em <strong>${calc.calendarDays} dias</strong>: Bruto <strong>+${formatBRL(calc.grossYield)}</strong> |
        Líquido c/ IOF: <strong class="text-emerald-400">+${formatBRL(calc.netYieldWithIof)}</strong> |
        Sem IOF: <strong class="text-purple-400">+${formatBRL(calc.netYieldWithoutIof)}</strong>
    `;
}

// ---------------------------------------------------------
// 8. EXCLUSÃO E NAVEGAÇÃO
// ---------------------------------------------------------
window.deleteTransaction = function(txId) {
    const tx = appState.transactions.find(t => t.id === txId);
    if (!tx) return;

    if (tx.type === 'credit_card' && tx.groupId && (tx.totalInstallments > 1)) {
        pendingDeleteTx = tx;
        document.getElementById('deleteInstallmentDesc').textContent = `A compra "${tx.desc}" possui parcelas vinculadas em outros meses.`;
        document.getElementById('deleteInstallmentModal').classList.remove('hidden');
    } else {
        appState.transactions = appState.transactions.filter(t => t.id !== txId);
        saveStateToCloud();
        showToast("Lançamento removido!");
    }
};

window.closeDeleteModal = function() {
    pendingDeleteTx = null;
    document.getElementById('deleteInstallmentModal').classList.add('hidden');
};

window.deleteVault = function(vaultId) {
    appState.vaults = appState.vaults.filter(v => v.id !== vaultId);
    saveStateToCloud();
    showToast("Cofrinho removido.");
};

window.switchMainTab = function(tabName) {
    currentTab = tabName;
    ['flow', 'card', 'investments'].forEach(t => {
        const section = document.getElementById(`tabSection-${t}`);
        const btn = document.getElementById(`mainTab-${t}`);
        if (t === tabName) {
            section.classList.remove('hidden');
            btn.classList.add('tab-active');
        } else {
            section.classList.add('hidden');
            btn.classList.remove('tab-active');
        }
    });
    renderAll();
};

function populateFlowCategories(flowType) {
    const select = document.getElementById('flowCategory');
    const list = FLOW_CATEGORIES[flowType] || FLOW_CATEGORIES.income;
    select.innerHTML = list.map(c => `<option value="${c}">${c}</option>`).join('');

    const repeatBox = document.getElementById('repeatMonthsContainer');
    const paidLabel = document.getElementById('flowPaidLabel');
    if (flowType === 'fixed') {
        repeatBox.classList.remove('hidden');
        paidLabel.textContent = 'Conta já está paga neste mês';
    } else if (flowType === 'income') {
        repeatBox.classList.add('hidden');
        paidLabel.textContent = 'Rendimento já recebido na conta';
    } else {
        repeatBox.classList.add('hidden');
        paidLabel.textContent = 'Gasto já debitado / pago';
    }
}

function updateCardInstallmentPreview() {
    const rawVal = Number(document.getElementById('cardAmount').value) || 0;
    const mode = document.getElementById('cardValueMode').value;
    const instSel = document.getElementById('cardTotalInstallments').value;
    const startInst = Number(document.getElementById('cardStartInstallment').value) || 1;
    const previewEl = document.getElementById('cardInstallmentCalcPreview');
    const startBox = document.getElementById('startingInstallmentBox');

    if (instSel === 'recurring') {
        startBox.classList.add('opacity-40', 'pointer-events-none');
        previewEl.textContent = `Assinatura fixa mensal de ${formatBRL(rawVal)} em todas as faturas seguintes.`;
        return;
    }

    startBox.classList.remove('opacity-40', 'pointer-events-none');
    const totalInst = Number(instSel) || 1;
    const perMonth = mode === 'total' ? (rawVal / totalInst) : rawVal;
    const fullPurchase = mode === 'total' ? rawVal : (rawVal * totalInst);

    if (totalInst === 1) {
        previewEl.textContent = `Compra à vista: 1x de ${formatBRL(rawVal)} nesta fatura.`;
    } else {
        previewEl.textContent = `Serão lançadas parcelas (da ${startInst}/${totalInst}) de ${formatBRL(perMonth)}/mês • Total: ${formatBRL(fullPurchase)}.`;
    }
}

function renderAll() {
    renderProfileSwitcherAndBanner();
    renderKPIsAndFlow();
    renderCreditCardTab();
    renderInvestmentsTab();
    if (window.lucide) window.lucide.createIcons();
}

// ---------------------------------------------------------
// 9. INICIALIZAÇÃO
// ---------------------------------------------------------
function initApp() {
    const todayISO = new Date().toISOString().slice(0, 10);
    document.getElementById('flowDate').value = todayISO;
    document.getElementById('cardDate').value = todayISO;
    document.getElementById('vaultStartDate').value = todayISO;
    document.getElementById('globalSimDate').value = todayISO;
    document.getElementById('filterStartDate').value = customStartDate;
    document.getElementById('filterEndDate').value = customEndDate;
    document.getElementById('globalCdiRate').value = appState.globalCdiRate || 11.15;

    populateFlowCategories('income');
    updateCardInstallmentPreview();
    renderAll();
    checkOnboardingState();
    initPersistence();

    document.getElementById('deleteOnlyOneBtn').addEventListener('click', () => {
        if (pendingDeleteTx) {
            appState.transactions = appState.transactions.filter(t => t.id !== pendingDeleteTx.id);
            closeDeleteModal();
            saveStateToCloud();
            showToast("Parcela deste mês removida.");
        }
    });

    document.getElementById('deleteAllGroupBtn').addEventListener('click', () => {
        if (pendingDeleteTx) {
            appState.transactions = appState.transactions.filter(t => t.groupId !== pendingDeleteTx.groupId);
            closeDeleteModal();
            saveStateToCloud();
            showToast("Todas as parcelas desta compra foram removidas.");
        }
    });

    document.getElementById('themeToggleBtn').addEventListener('click', () => {
        document.documentElement.classList.toggle('dark');
    });

    document.getElementById('prevMonthBtn').addEventListener('click', () => {
        viewMonth--;
        if (viewMonth < 0) { viewMonth = 11; viewYear--; }
        renderAll();
    });

    document.getElementById('nextMonthBtn').addEventListener('click', () => {
        viewMonth++;
        if (viewMonth > 11) { viewMonth = 0; viewYear++; }
        renderAll();
    });

    document.getElementById('toggleCustomRangeBtn').addEventListener('click', () => {
        useCustomDateRange = !useCustomDateRange;
        document.getElementById('customRangeInputs').classList.toggle('hidden', !useCustomDateRange);
        document.getElementById('monthModeSelector').classList.toggle('hidden', useCustomDateRange);
        renderAll();
    });

    document.getElementById('clearCustomRangeBtn').addEventListener('click', () => {
        useCustomDateRange = false;
        document.getElementById('customRangeInputs').classList.add('hidden');
        document.getElementById('monthModeSelector').classList.remove('hidden');
        renderAll();
    });

    document.getElementById('filterStartDate').addEventListener('change', (e) => {
        customStartDate = e.target.value;
        renderAll();
    });

    document.getElementById('filterEndDate').addEventListener('change', (e) => {
        customEndDate = e.target.value;
        renderAll();
    });

    document.querySelectorAll('.flow-type-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const t = btn.getAttribute('data-flowtype');
            document.getElementById('flowTypeInput').value = t;
            document.querySelectorAll('.flow-type-btn').forEach(b => {
                b.className = 'flow-type-btn py-2 px-2 rounded-xl border text-center text-xs font-bold transition border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800/60 text-slate-600 dark:text-slate-300';
            });
            if (t === 'income') {
                btn.className = 'flow-type-btn py-2 px-2 rounded-xl border text-center text-xs font-bold transition border-emerald-500 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400';
            } else if (t === 'fixed') {
                btn.className = 'flow-type-btn py-2 px-2 rounded-xl border text-center text-xs font-bold transition border-blue-500 bg-blue-500/10 text-blue-600 dark:text-blue-400';
            } else {
                btn.className = 'flow-type-btn py-2 px-2 rounded-xl border text-center text-xs font-bold transition border-cyan-500 bg-cyan-500/10 text-cyan-600 dark:text-cyan-400';
            }
            populateFlowCategories(t);
        });
    });

    document.getElementById('flowForm').addEventListener('submit', (e) => {
        e.preventDefault();
        if (!appState.activeProfileId) {
            checkOnboardingState();
            return;
        }
        const type = document.getElementById('flowTypeInput').value;
        const desc = document.getElementById('flowDesc').value.trim();
        const amount = parseFloat(document.getElementById('flowAmount').value);
        const date = document.getElementById('flowDate').value;
        const category = document.getElementById('flowCategory').value;
        const paid = document.getElementById('flowPaid').checked;
        const repeatCount = type === 'fixed' ? (parseInt(document.getElementById('flowRepeatMonths').value) || 1) : 1;

        if (!desc || isNaN(amount) || !date) return;

        for (let i = 0; i < repeatCount; i++) {
            const targetDate = addMonthsToDateStr(date, i);
            appState.transactions.push({
                id: 'tx_' + Date.now() + '_' + i,
                profileId: appState.activeProfileId,
                type,
                desc,
                amount,
                date: targetDate,
                category,
                paid: i === 0 ? paid : false
            });
        }

        document.getElementById('flowDesc').value = '';
        document.getElementById('flowAmount').value = '';
        document.getElementById('flowRepeatMonths').value = '1';
        saveStateToCloud();
        showToast(repeatCount > 1 ? `Conta fixa lançada para ${repeatCount} meses!` : "Lançamento adicionado ao fluxo!");
    });

    document.getElementById('valModeTotalBtn').addEventListener('click', () => {
        document.getElementById('cardValueMode').value = 'total';
        document.getElementById('cardAmountLabel').textContent = 'Valor Total (R$)';
        document.getElementById('valModeTotalBtn').className = 'px-2 py-0.5 rounded bg-orange-500 text-white font-bold';
        document.getElementById('valModeInstallmentBtn').className = 'px-2 py-0.5 rounded bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-400 font-semibold';
        updateCardInstallmentPreview();
    });

    document.getElementById('valModeInstallmentBtn').addEventListener('click', () => {
        document.getElementById('cardValueMode').value = 'installment';
        document.getElementById('cardAmountLabel').textContent = 'Valor da Parcela (R$)';
        document.getElementById('valModeInstallmentBtn').className = 'px-2 py-0.5 rounded bg-orange-500 text-white font-bold';
        document.getElementById('valModeTotalBtn').className = 'px-2 py-0.5 rounded bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-400 font-semibold';
        updateCardInstallmentPreview();
    });

    ['cardAmount', 'cardTotalInstallments', 'cardStartInstallment'].forEach(id => {
        document.getElementById(id).addEventListener('input', updateCardInstallmentPreview);
        document.getElementById(id).addEventListener('change', updateCardInstallmentPreview);
    });

    document.getElementById('cardForm').addEventListener('submit', (e) => {
        e.preventDefault();
        if (!appState.activeProfileId) {
            checkOnboardingState();
            return;
        }
        const desc = document.getElementById('cardDesc').value.trim();
        const cardName = document.getElementById('cardBankName').value;
        const category = document.getElementById('cardCategory').value;
        const rawAmount = parseFloat(document.getElementById('cardAmount').value);
        const date = document.getElementById('cardDate').value;
        const mode = document.getElementById('cardValueMode').value;
        const instSel = document.getElementById('cardTotalInstallments').value;
        const startInst = Math.max(1, parseInt(document.getElementById('cardStartInstallment').value) || 1);

        if (!desc || isNaN(rawAmount) || !date) return;

        const groupId = 'grp_' + Date.now();

        if (instSel === 'recurring') {
            appState.transactions.push({
                id: 'cc_' + Date.now(),
                profileId: appState.activeProfileId,
                type: 'credit_card',
                desc,
                amount: rawAmount,
                totalPurchaseAmount: rawAmount,
                date,
                cardName,
                category,
                installmentNumber: 1,
                totalInstallments: 1,
                isRecurring: true,
                groupId
            });
            showToast("Assinatura recorrente adicionada ao cartão!");
        } else {
            const totalInst = parseInt(instSel) || 1;
            const installmentValue = mode === 'total' ? Number((rawAmount / totalInst).toFixed(2)) : rawAmount;
            const totalPurchaseAmount = mode === 'total' ? rawAmount : Number((rawAmount * totalInst).toFixed(2));

            let monthOffset = 0;
            for (let inst = startInst; inst <= totalInst; inst++) {
                const targetDate = addMonthsToDateStr(date, monthOffset);
                appState.transactions.push({
                    id: `cc_${Date.now()}_${inst}`,
                    profileId: appState.activeProfileId,
                    type: 'credit_card',
                    desc,
                    amount: installmentValue,
                    totalPurchaseAmount,
                    date: targetDate,
                    cardName,
                    category,
                    installmentNumber: inst,
                    totalInstallments: totalInst,
                    isRecurring: false,
                    groupId
                });
                monthOffset++;
            }
            showToast(`Compra lançada (${totalInst}x de ${formatBRL(installmentValue)})!`);
        }

        document.getElementById('cardDesc').value = '';
        document.getElementById('cardAmount').value = '';
        document.getElementById('cardStartInstallment').value = '1';
        updateCardInstallmentPreview();
        saveStateToCloud();
    });

    document.getElementById('filterCardBank').addEventListener('change', renderCreditCardTab);

    ['vaultPrincipal', 'vaultStartDate', 'vaultCdiPercent', 'vaultTaxType', 'globalCdiRate', 'globalSimDate'].forEach(id => {
        document.getElementById(id).addEventListener('input', () => {
            appState.globalCdiRate = Number(document.getElementById('globalCdiRate').value) || 11.15;
            renderInvestmentsTab();
            renderKPIsAndFlow();
        });
    });

    document.getElementById('vaultForm').addEventListener('submit', (e) => {
        e.preventDefault();
        if (!appState.activeProfileId) {
            checkOnboardingState();
            return;
        }
        const name = document.getElementById('vaultName').value.trim();
        const principal = parseFloat(document.getElementById('vaultPrincipal').value);
        const startDate = document.getElementById('vaultStartDate').value;
        const cdiPercent = parseFloat(document.getElementById('vaultCdiPercent').value) || 100;
        const taxType = document.getElementById('vaultTaxType').value;

        if (!name || isNaN(principal) || !startDate) return;

        appState.vaults.push({
            id: 'v_' + Date.now(),
            profileId: appState.activeProfileId,
            name,
            principal,
            startDate,
            cdiPercent,
            taxType
        });

        document.getElementById('vaultName').value = '';
        document.getElementById('vaultPrincipal').value = '';
        saveStateToCloud();
        showToast("Cofrinho adicionado com cálculo de IOF e IR!");
    });

    document.getElementById('openProfileModalBtn').addEventListener('click', () => {
        checkOnboardingState();
        renderProfileModalCards();
        document.getElementById('profileLoginModal').classList.remove('hidden');
    });

    document.getElementById('closeProfileModalBtn').addEventListener('click', () => {
        if (appState.profiles.length > 0) {
            document.getElementById('profileLoginModal').classList.add('hidden');
        }
    });

    document.getElementById('toggleNewProfileFormBtn').addEventListener('click', () => {
        document.getElementById('newProfileForm').classList.toggle('hidden');
        document.getElementById('newProfName').focus();
    });

    document.getElementById('newProfileForm').addEventListener('submit', (e) => {
        e.preventDefault();
        const name = document.getElementById('newProfName').value.trim();
        const color = document.getElementById('newProfColor').value;
        const pin = document.getElementById('newProfPin').value.trim();
        if (!name) return;

        const newId = 'prof_' + Date.now();
        appState.profiles.push({ id: newId, name, color, pin });
        appState.activeProfileId = newId;

        document.getElementById('newProfName').value = '';
        document.getElementById('newProfPin').value = '';
        document.getElementById('newProfileForm').classList.add('hidden');
        document.getElementById('profileLoginModal').classList.add('hidden');
        checkOnboardingState();
        saveStateToCloud();
        showToast(`Perfil "${name}" criado com sucesso!`);
    });

    document.getElementById('confirmPinBtn').addEventListener('click', () => {
        const typed = document.getElementById('pinVerifyInput').value;
        const target = appState.profiles.find(p => p.id === pendingPinProfileId);
        if (target && target.pin === typed) {
            appState.activeProfileId = target.id;
            pendingPinProfileId = null;
            document.getElementById('pinVerifyBox').classList.add('hidden');
            document.getElementById('profileLoginModal').classList.add('hidden');
            saveStateToCloud();
            showToast(`Bem-vindo(a), ${target.name}!`);
        } else {
            document.getElementById('pinErrorMsg').classList.remove('hidden');
        }
    });

    document.getElementById('cancelPinBtn').addEventListener('click', () => {
        pendingPinProfileId = null;
        document.getElementById('pinVerifyBox').classList.add('hidden');
    });

    document.getElementById('clearProfileDataBtn').addEventListener('click', () => {
        const prof = getActiveProfile();
        if (!prof) return;
        appState.transactions = appState.transactions.filter(t => t.profileId !== prof.id);
        appState.vaults = appState.vaults.filter(v => v.profileId !== prof.id);
        saveStateToCloud();
        showToast(`Lançamentos de ${prof.name} zerados.`);
    });

    document.getElementById('exportJsonBtn').addEventListener('click', () => {
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(appState, null, 2));
        const a = document.createElement('a');
        a.setAttribute("href", dataStr);
        a.setAttribute("download", `financontrol_backup_${new Date().toISOString().slice(0,10)}.json`);
        document.body.appendChild(a);
        a.click();
        a.remove();
        showToast("Backup JSON baixado!");
    });

    document.getElementById('importJsonInput').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            try {
                const imported = JSON.parse(ev.target.result);
                if (imported && Array.isArray(imported.profiles)) {
                    appState = imported;
                    saveStateToCloud();
                    checkOnboardingState();
                    showToast("Backup restaurado com sucesso!");
                }
            } catch (err) {
                showToast("Arquivo JSON inválido.");
            }
        };
        reader.readAsText(file);
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
} else {
    initApp();
}