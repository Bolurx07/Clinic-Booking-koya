// Everything from the server is written with textContent, never as HTML, so a provider
// name can't inject markup into the page.

const elements = {
  provider: document.querySelector('#provider'),
  refresh: document.querySelector('#refresh'),
  slotsStatus: document.querySelector('#slots-status'),
  slotsError: document.querySelector('#slots-error'),
  slotsFieldset: document.querySelector('#slots-fieldset'),
  slots: document.querySelector('#slots'),
  form: document.querySelector('#booking-form'),
  selectedSlot: document.querySelector('#selected-slot'),
  name: document.querySelector('#name'),
  email: document.querySelector('#email'),
  submit: document.querySelector('#submit'),
  bookingError: document.querySelector('#booking-error'),
  bookingErrorTitle: document.querySelector('#booking-error-title'),
  bookingErrorDetail: document.querySelector('#booking-error-detail'),
  confirmation: document.querySelector('#confirmation'),
  confirmationHeading: document.querySelector('#confirmation-heading'),
  confirmedId: document.querySelector('#confirmed-id'),
  confirmedProvider: document.querySelector('#confirmed-provider'),
  confirmedTime: document.querySelector('#confirmed-time'),
  bookAnother: document.querySelector('#book-another'),
};

let slots = [];
let selectedSlotId = null;
let submitting = false;
// Kept only while the outcome of a request is unknown, so retrying can't book twice.
let unresolvedAttempt = null;

const dateFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const zoneFormat = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' });

function formatTimes(slot) {
  const start = new Date(slot.start);
  const zone = zoneFormat.formatToParts(start).find((part) => part.type === 'timeZoneName')?.value ?? '';
  return `${timeFormat.format(start)} to ${timeFormat.format(new Date(slot.end))} ${zone}`.trim();
}

function formatSlot(slot) {
  return `${dateFormat.format(new Date(slot.start))}, ${formatTimes(slot)}`;
}

// `available` only reflects bookings, so a past slot with no booking still needs this time check.
function slotState(slot) {
  if (new Date(slot.start) <= new Date()) return { label: 'Started', bookable: false };
  if (!slot.available) return { label: 'Booked', bookable: false };
  return { label: 'Available', bookable: true };
}

function findSelectedSlot() {
  return slots.find((slot) => slot.id === selectedSlotId) ?? null;
}

function renderProviders() {
  const current = elements.provider.value;
  const providers = [...new Set(slots.map((slot) => slot.provider))].sort((a, b) => a.localeCompare(b));

  elements.provider.replaceChildren(new Option('All providers', ''), ...providers.map((name) => new Option(name, name)));
  elements.provider.value = providers.includes(current) ? current : '';
}

function createSlotItem(slot) {
  const { label, bookable } = slotState(slot);

  const input = document.createElement('input');
  input.type = 'radio';
  input.name = 'slot';
  input.value = slot.id;
  input.disabled = !bookable;
  input.checked = slot.id === selectedSlotId;
  input.addEventListener('change', () => {
    selectedSlotId = slot.id;
    hideBookingError();
    renderSelection();
  });

  const provider = document.createElement('span');
  provider.className = 'slot-provider';
  provider.textContent = slot.provider;

  const date = document.createElement('span');
  date.className = 'slot-date';
  date.textContent = dateFormat.format(new Date(slot.start));

  const times = document.createElement('span');
  times.className = 'slot-times';
  times.textContent = formatTimes(slot);

  const text = document.createElement('span');
  text.className = 'slot-text';
  text.append(provider, date, times);

  const badge = document.createElement('span');
  badge.className = `badge badge-${label.toLowerCase()}`;
  badge.textContent = label;

  const row = document.createElement('label');
  row.className = bookable ? 'slot' : 'slot slot-disabled';
  row.append(input, text, badge);

  const item = document.createElement('li');
  item.append(row);
  return item;
}

function renderSlots() {
  const provider = elements.provider.value;
  const visible = slots.filter((slot) => !provider || slot.provider === provider);

  // A selection that was just booked, or is now filtered out of view, can't stay selected.
  // The exception is an unknown outcome: the slot may show as booked because this person's own
  // request succeeded, and retrying is the only way for them to get their confirmation.
  const selected = visible.find((slot) => slot.id === selectedSlotId);
  const awaitingRetry = selected && unresolvedAttempt?.slotId === selected.id;
  if (!selected || (!slotState(selected).bookable && !awaitingRetry)) {
    selectedSlotId = null;
  }

  elements.slots.replaceChildren(...visible.map(createSlotItem));
  elements.slotsFieldset.hidden = visible.length === 0;

  const bookableCount = visible.filter((slot) => slotState(slot).bookable).length;
  elements.slotsStatus.textContent =
    visible.length === 0
      ? 'No appointment times to show.'
      : `${bookableCount} of ${visible.length} ${visible.length === 1 ? 'time' : 'times'} available.`;

  renderSelection();
}

function renderSelection() {
  const slot = findSelectedSlot();
  elements.selectedSlot.textContent = slot
    ? `${slot.provider}, ${formatSlot(slot)}`
    : 'None yet. Choose a time from the list.';
  elements.submit.disabled = !slot || submitting;
  elements.submit.textContent = submitting ? 'Booking…' : 'Book appointment';
}

async function loadSlots() {
  elements.slotsError.hidden = true;
  try {
    const response = await fetch('/web/slots');
    const body = await response.json();
    if (!response.ok) throw new Error(body.error);

    slots = body.slots;
    renderProviders();
    renderSlots();
  } catch (err) {
    elements.slotsStatus.textContent = '';
    elements.slotsError.textContent = `Could not load appointment times. ${err.message} Use Refresh to try again.`;
    elements.slotsError.hidden = false;
  }
}

function hideBookingError() {
  elements.bookingError.hidden = true;
}

function showBookingError(title, detail) {
  elements.bookingErrorTitle.textContent = title;
  elements.bookingErrorDetail.textContent = detail;
  elements.bookingError.hidden = false;
  elements.bookingError.focus();
}

function describeApiError(status, message, retryAfter) {
  switch (status) {
    case 400:
      return ['Please check your booking', `${message} (error 400)`];
    case 404:
      return ['That time no longer exists', `Please choose another time. (error 404)`];
    case 409:
      return ['That time has just been taken', `Please choose another time. (error 409)`];
    case 429:
      return [
        'Too many attempts for this email',
        `Please try again in ${retryAfter ?? 'a few'} ${retryAfter === '1' ? 'second' : 'seconds'}. (error 429)`,
      ];
    default:
      return ['Something went wrong', `Please try again. It will not book twice. (error ${status}: ${message})`];
  }
}

function showConfirmation(booking, slot) {
  elements.confirmedId.textContent = booking.id;
  elements.confirmedProvider.textContent = slot.provider;
  elements.confirmedTime.textContent = formatSlot(slot);

  elements.form.hidden = true;
  elements.confirmation.hidden = false;
  elements.confirmationHeading.focus();
}

async function submitBooking(event) {
  event.preventDefault();
  const slot = findSelectedSlot();
  if (!slot || submitting) return;

  const body = JSON.stringify({ slot_id: slot.id, name: elements.name.value, email: elements.email.value });
  if (unresolvedAttempt?.body !== body) {
    unresolvedAttempt = { body, slotId: slot.id, key: crypto.randomUUID() };
  }

  submitting = true;
  hideBookingError();
  renderSelection();

  try {
    const response = await fetch('/web/bookings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': unresolvedAttempt.key },
      body,
    });
    const result = await response.json();

    // A stored 4xx would replay for this key, so correcting a field needs a new one.
    // A 5xx stored nothing, so keeping the key is safe.
    if (response.status < 500) {
      unresolvedAttempt = null;
    }

    if (response.status === 201) {
      showConfirmation(result, slot);
    } else {
      showBookingError(...describeApiError(response.status, result.error, response.headers.get('Retry-After')));
    }
  } catch {
    showBookingError(
      'Could not reach the server',
      'Your booking may not have gone through. Press Book appointment to try again. It will not book twice.',
    );
  } finally {
    submitting = false;
    await loadSlots();
  }
}

function startAnotherBooking() {
  elements.form.reset();
  elements.confirmation.hidden = true;
  elements.form.hidden = false;
  hideBookingError();
  renderSelection();
  elements.slots.querySelector('input:not(:disabled)')?.focus();
}

elements.provider.addEventListener('change', renderSlots);
elements.refresh.addEventListener('click', loadSlots);
elements.form.addEventListener('submit', submitBooking);
elements.bookAnother.addEventListener('click', startAnotherBooking);

loadSlots();
