import { h, render, qsa } from '../lib/dom.js';
import { HYREO_LOGO_URL } from '../lib/brand.js';
import { icon, notify, apiError } from '../lib/ui.js';
import api from '../lib/api.js';
import store from '../lib/store.js';
import router from '../lib/router.js';

/** Email-OTP sign in. No passwords anywhere in the product. */
export function loginPage(root) {
  const panel = h('div.auth__card');
  render(root, h('div.auth', brandPanel(), h('div.auth__panel', panel)));
  renderEmailStep(panel);
}

function brandPanel() {
  return h(
    'section.auth__brand',
    h(
      'div.auth__logo',
      h('div.brand.brand--lg', h('img.brand__logo', { src: HYREO_LOGO_URL, alt: 'Hyreo' }), h('div.sidebar__subtitle', 'Change Request Management'))
    ),
    h(
      'div',
      h('h2.auth__headline', 'Every change request,\nfrom draft to signature.'),
      h(
        'p.auth__lede',
        'One system of record for customer accounts, MSA contracts, change request estimation, internal approval, document generation and customer signature.'
      ),
      h(
        'div.auth__points',
        ...[
          'Account → MSA → Change Request as a single spine',
          'Effort and cost calculated, never keyed twice',
          'Word and PDF change request documents on demand',
          'OTP-verified approval and customer signature',
          'Immutable audit trail for every action'
        ].map((text) => h('div.auth__point', h('span.auth__point-tick', icon('check', 11)), text))
      )
    ),
    h('div.auth__foot', `© ${new Date().getFullYear()} Hyreo Services India Private Limited`)
  );
}

function renderEmailStep(panel, presetEmail = '') {
  const emailInput = h('input.input', {
    type: 'email',
    name: 'email',
    placeholder: 'you@company.com',
    autocomplete: 'email',
    value: presetEmail,
    autofocus: true
  });
  const button = h('button.btn.btn--primary.btn--lg.btn--block', { type: 'submit' }, 'Send OTP');

  const form = h(
    'form',
    {
      onSubmit: async (event) => {
        event.preventDefault();
        const email = emailInput.value.trim();
        if (!email) {
          emailInput.classList.add('is-invalid');
          return;
        }
        button.disabled = true;
        render(button, h('span.spinner'), 'Sending…');
        try {
          await api.post('/api/auth/otp/request', { email });
          notify.success(`Verification code sent to ${email}`);
          renderOtpStep(panel, email);
        } catch (error) {
          apiError(error);
          button.disabled = false;
          render(button, 'Send OTP');
        }
      }
    },
    h('div.field', h('label.field__label', 'Email address'), emailInput),
    button
  );

  render(
    panel,
    h('h1.auth__title', 'Hyreo Change Request Management'),
    h('p.auth__sub', 'Enter your work email address and we will send you a one-time passcode.'),
    form,
    h(
      'div.alert.alert--info.mt-3',
      icon('info', 17),
      h(
        'div',
        h('div.alert__title', 'Password-free sign in'),
        'Access is granted through a one-time code sent to your registered email address.'
      )
    )
  );
}

function renderOtpStep(panel, email) {
  const boxes = Array.from({ length: 6 }, (_, index) =>
    h('input', {
      type: 'text',
      inputmode: 'numeric',
      maxlength: '1',
      'aria-label': `Digit ${index + 1}`,
      autocomplete: index === 0 ? 'one-time-code' : 'off'
    })
  );

  const verifyButton = h('button.btn.btn--primary.btn--lg.btn--block', { type: 'submit' }, 'Verify OTP');
  const resendButton = h('button.btn.btn--ghost.btn--block', { type: 'button' }, 'Resend OTP');

  const code = () => boxes.map((box) => box.value).join('');

  boxes.forEach((box, index) => {
    box.addEventListener('input', () => {
      box.value = box.value.replace(/\D/g, '').slice(0, 1);
      if (box.value && index < 5) boxes[index + 1].focus();
      if (code().length === 6) verifyButton.focus();
    });
    box.addEventListener('keydown', (event) => {
      if (event.key === 'Backspace' && !box.value && index > 0) boxes[index - 1].focus();
      if (event.key === 'ArrowLeft' && index > 0) boxes[index - 1].focus();
      if (event.key === 'ArrowRight' && index < 5) boxes[index + 1].focus();
    });
    box.addEventListener('paste', (event) => {
      const text = (event.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 6);
      if (!text) return;
      event.preventDefault();
      text.split('').forEach((digit, offset) => {
        if (boxes[offset]) boxes[offset].value = digit;
      });
      boxes[Math.min(text.length, 5)].focus();
    });
  });

  let cooldown = 0;
  const tick = () => {
    if (cooldown > 0) {
      resendButton.disabled = true;
      render(resendButton, `Resend OTP in ${cooldown}s`);
      cooldown -= 1;
      setTimeout(tick, 1000);
    } else {
      resendButton.disabled = false;
      render(resendButton, 'Resend OTP');
    }
  };
  cooldown = store.settings?.otp?.resend_cooldown_seconds || 60;
  tick();

  resendButton.addEventListener('click', async () => {
    try {
      await api.post('/api/auth/otp/resend', { email });
      notify.success('A new code is on its way.');
      cooldown = 60;
      tick();
    } catch (error) {
      apiError(error);
    }
  });

  const form = h(
    'form',
    {
      onSubmit: async (event) => {
        event.preventDefault();
        if (code().length !== 6) {
          notify.warning('Enter all six digits.');
          return;
        }
        verifyButton.disabled = true;
        render(verifyButton, h('span.spinner'), 'Verifying…');
        try {
          const data = await api.post('/api/auth/otp/verify', { email, code: code() });
          store.setSession(data.user, data.settings);
          await store.loadSession();
          notify.success(`Welcome back, ${data.user.name.split(' ')[0]}.`);
          router.navigate('/dashboard');
        } catch (error) {
          apiError(error);
          boxes.forEach((box) => {
            box.value = '';
          });
          boxes[0].focus();
          verifyButton.disabled = false;
          render(verifyButton, 'Verify OTP');
        }
      }
    },
    h('div.otp-inputs', ...boxes),
    h('div.mt-2', verifyButton),
    h('div.mt-1', resendButton)
  );

  render(
    panel,
    h(
      'button.btn.btn--ghost.btn--sm.mb-2',
      { onClick: () => renderEmailStep(panel, email) },
      icon('chevronLeft', 14),
      'Use a different email'
    ),
    h('h1.auth__title', 'OTP verification'),
    h('p.auth__sub', h('span', 'Enter the 6-digit OTP sent to '), h('strong', email)),
    form
  );

  boxes[0].focus();
}

export default loginPage;
