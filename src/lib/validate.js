import { errors } from './errors.js';
import { isValidDate, toDateOnly } from './dates.js';
import { toNumber } from './money.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isEmail(value) {
  return EMAIL_RE.test(String(value || '').trim());
}

export function normaliseEmail(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * Declarative validator.
 * schema: { field: { type, required, label, min, max, maxLength, enum, default } }
 * type: string | text | email | number | integer | boolean | date | array | object
 */
export function validate(payload, schema, { partial = false } = {}) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const out = {};
  const details = [];

  for (const [field, rule] of Object.entries(schema)) {
    const label = rule.label || field;
    const present = Object.prototype.hasOwnProperty.call(input, field);
    let value = input[field];

    if (!present) {
      if (partial) continue;
      if (rule.default !== undefined) {
        out[field] = rule.default;
        continue;
      }
      if (rule.required) {
        details.push({ field, message: `${label} is required` });
        continue;
      }
      out[field] = rule.type === 'array' ? [] : null;
      continue;
    }

    if (value === null || value === undefined || value === '') {
      if (rule.required) {
        details.push({ field, message: `${label} is required` });
        continue;
      }
      out[field] = rule.type === 'array' ? [] : null;
      continue;
    }

    switch (rule.type) {
      case 'email': {
        const email = normaliseEmail(value);
        if (!isEmail(email)) {
          details.push({ field, message: `${label} must be a valid email address` });
          continue;
        }
        out[field] = email;
        break;
      }
      case 'number':
      case 'integer': {
        const num = toNumber(value, NaN);
        if (!Number.isFinite(num)) {
          details.push({ field, message: `${label} must be a number` });
          continue;
        }
        const finalNum = rule.type === 'integer' ? Math.trunc(num) : num;
        if (rule.min !== undefined && finalNum < rule.min) {
          details.push({ field, message: `${label} must be at least ${rule.min}` });
          continue;
        }
        if (rule.max !== undefined && finalNum > rule.max) {
          details.push({ field, message: `${label} must not exceed ${rule.max}` });
          continue;
        }
        out[field] = finalNum;
        break;
      }
      case 'boolean': {
        out[field] = value === true || value === 1 || value === '1' || value === 'true' ? 1 : 0;
        break;
      }
      case 'date': {
        if (!isValidDate(value)) {
          details.push({ field, message: `${label} must be a valid date` });
          continue;
        }
        out[field] = toDateOnly(value);
        break;
      }
      case 'array': {
        if (!Array.isArray(value)) {
          details.push({ field, message: `${label} must be a list` });
          continue;
        }
        if (rule.minItems !== undefined && value.length < rule.minItems) {
          details.push({ field, message: `${label} must contain at least ${rule.minItems} item(s)` });
          continue;
        }
        if (rule.maxItems !== undefined && value.length > rule.maxItems) {
          details.push({ field, message: `${label} must contain at most ${rule.maxItems} item(s)` });
          continue;
        }
        out[field] = value;
        break;
      }
      case 'object': {
        if (typeof value !== 'object' || Array.isArray(value)) {
          details.push({ field, message: `${label} must be an object` });
          continue;
        }
        out[field] = value;
        break;
      }
      default: {
        const text = String(value).trim();
        const maxLength = rule.maxLength || (rule.type === 'text' ? 20000 : 500);
        if (rule.minLength && text.length < rule.minLength) {
          details.push({ field, message: `${label} must be at least ${rule.minLength} characters` });
          continue;
        }
        if (text.length > maxLength) {
          details.push({ field, message: `${label} must not exceed ${maxLength} characters` });
          continue;
        }
        if (rule.enum && !rule.enum.includes(text)) {
          details.push({ field, message: `${label} must be one of: ${rule.enum.join(', ')}` });
          continue;
        }
        if (rule.pattern && !rule.pattern.test(text)) {
          details.push({ field, message: rule.patternMessage || `${label} is not in the expected format` });
          continue;
        }
        out[field] = rule.upper ? text.toUpperCase() : text;
      }
    }
  }

  if (details.length) {
    throw errors.validation(details.length === 1 ? details[0].message : 'Please correct the highlighted fields', details);
  }
  return out;
}

export function requireFields(object, fields, labels = {}) {
  const details = fields
    .filter((f) => object[f] === undefined || object[f] === null || object[f] === '')
    .map((f) => ({ field: f, message: `${labels[f] || f} is required` }));
  if (details.length) throw errors.validation('Please complete the required fields', details);
}
