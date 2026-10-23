// 規則數值以後端為準（BR-08），前端只做體驗上的提前提示
const MAX_GUESTS = 10;
const SLOTS = ['11:30', '12:30', '17:30', '18:30'];
const MSG = {
  REQUIRED: 'This field is required',                        // BR-01
  INVALID_PHONE: 'Please enter a valid phone number',        // BR-02
  OUT_OF_RANGE_DATE: 'Please pick a date within the next 30 days', // BR-04
  DUPLICATE: 'You already have a reservation for this time', // BR-07
  slotFull: (n) => `Only ${n} seats left for this time`,     // BR-06
  GENERIC: 'Something went wrong, please try again',
};

const $ = (id) => document.getElementById(id);
const form = $('booking-form');
const formError = form.querySelector('[data-testid="form-error"]');
const submitBtn = form.querySelector('[data-testid="submit"]');
let guests = 1;
let range = null;

function setError(field, msg) {
  $(`${field}-error`).textContent = msg || '';
  const input = $(field);
  if (input) input.setAttribute('aria-invalid', msg ? 'true' : 'false');
}
function clearErrors() {
  ['name', 'phone', 'date', 'slot'].forEach((f) => setError(f, ''));
  formError.hidden = true;
  formError.textContent = '';
}
function showFormError(msg) {
  formError.textContent = msg;
  formError.hidden = false;
}

// BR-03：人數 1–10，到邊界停用按鈕
function renderGuests() {
  $('guests').textContent = guests;
  $('guests-minus').disabled = guests <= 1;
  $('guests-plus').disabled = guests >= MAX_GUESTS;
}
$('guests-minus').addEventListener('click', () => { guests = Math.max(1, guests - 1); renderGuests(); });
$('guests-plus').addEventListener('click', () => { guests = Math.min(MAX_GUESTS, guests + 1); renderGuests(); });

// BR-05、BR-12：四個時段，顯示剩餘名額，額滿停用
function renderSlots(slots) {
  const checked = form.querySelector('input[name="slot"]:checked')?.value;
  $('slots').innerHTML = '';
  for (const s of slots) {
    const full = s.remaining !== undefined && s.remaining <= 0;
    const label = document.createElement('label');
    label.className = 'slot';
    label.dataset.testid = `slot-${s.slot}`;
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'slot';
    input.value = s.slot;
    input.disabled = full || s.remaining === undefined;
    input.checked = !full && checked === s.slot;
    const text = document.createElement('span');
    text.textContent = s.slot;
    const small = document.createElement('small');
    small.dataset.testid = `slot-${s.slot}-remaining`;
    small.textContent = s.remaining === undefined ? 'Pick a date' : full ? 'Full' : `${s.remaining} left`;
    label.append(input, text, small);
    $('slots').append(label);
  }
}

async function loadAvailability(date) {
  const res = await fetch(`/api/availability?date=${encodeURIComponent(date)}`);
  if (!res.ok) return null;
  return res.json();
}

$('date').addEventListener('change', async () => {
  const date = $('date').value;
  if (!date) return renderSlots(SLOTS.map((slot) => ({ slot })));
  const data = await loadAvailability(date);
  if (data) renderSlots(data.slots);
});

function validate(v) {
  const e = {};
  if (!v.name) e.name = MSG.REQUIRED;
  if (!v.phone) e.phone = MSG.REQUIRED;
  else if (!/^09\d{8}$/.test(v.phone)) e.phone = MSG.INVALID_PHONE;
  if (!v.date) e.date = MSG.REQUIRED;
  else if (range && (v.date < range.min || v.date > range.max)) e.date = MSG.OUT_OF_RANGE_DATE;
  if (!v.slot) e.slot = MSG.REQUIRED;
  return e;
}

function readForm() {
  return {
    name: $('name').value.trim(),
    phone: $('phone').value.trim(),
    date: $('date').value,
    slot: form.querySelector('input[name="slot"]:checked')?.value || '',
    guests,
  };
}

// 即時回饋：打字時清除該欄紅字，離開欄位時再檢查格式（空白留到送出時才提示必填）
for (const field of ['name', 'phone', 'date']) {
  $(field).addEventListener('input', () => setError(field, ''));
  $(field).addEventListener('blur', () => {
    const v = readForm();
    if (v[field]) setError(field, validate(v)[field]);
  });
}
// 時段按鈕會重新產生，所以掛在外層容器上：選了時段就清除紅字
$('slots').addEventListener('change', () => setError('slot', ''));

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (submitBtn.disabled) return;
  clearErrors();
  const v = readForm();
  const errors = validate(v);
  if (Object.keys(errors).length) {
    Object.entries(errors).forEach(([f, m]) => setError(f, m));
    return; // TC-01-1：前端擋下時不送 API
  }

  submitBtn.disabled = true; // 送出中停用，避免重複送出
  try {
    const res = await fetch('/api/reservations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(v),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 201) {
      form.hidden = true;
      $('success').hidden = false;
      $('success').querySelector('[data-testid="success-summary"]').textContent =
        `${data.name}, ${data.guests} guest(s) on ${data.date} at ${data.slot}`;
      return;
    }
    if (data.error === 'SLOT_FULL') {
      showFormError(MSG.slotFull(data.remaining));
      const fresh = await loadAvailability(v.date);
      if (fresh) renderSlots(fresh.slots);
    } else if (data.error === 'DUPLICATE') {
      showFormError(MSG.DUPLICATE);
    } else if (data.error === 'VALIDATION_ERROR') {
      for (const [f, code] of Object.entries(data.fields || {})) {
        const msg = code === 'REQUIRED' ? MSG.REQUIRED
          : f === 'phone' ? MSG.INVALID_PHONE
          : f === 'date' ? MSG.OUT_OF_RANGE_DATE
          : MSG.GENERIC;
        if ($(`${f}-error`)) setError(f, msg); else showFormError(msg);
      }
    } else {
      showFormError(MSG.GENERIC);
    }
  } catch {
    showFormError(MSG.GENERIC);
  } finally {
    submitBtn.disabled = false;
  }
});

// 初始化：日期範圍以後端回傳為準（BR-04，台灣時間）
(async () => {
  renderGuests();
  renderSlots(SLOTS.map((slot) => ({ slot })));
  const today = new Date().toISOString().slice(0, 10);
  const data = await loadAvailability(today);
  if (data) {
    range = data.range;
    $('date').min = range.min;
    $('date').max = range.max;
  }
})();
