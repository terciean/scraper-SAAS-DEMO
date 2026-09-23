// Fixtures are taken verbatim from real outreach transcripts (lead history).
// They are the regression suite for the classifier and name extractor.
import test from 'node:test';
import assert from 'node:assert';
import {
  renderOpener, renderPitch, extractContactName,
  classifyReply, classifyPostPitch, cleanBrandName, selectPitchVariant,
} from '../src/templates.js';
import { extractSocials } from '../src/enrich/website.js';

const OPENER_REPLIES = [
  ['Hi \n\nYes', 'confirmed', null],
  ['Good day\nThis is Natasha Aitken Aesthetics Clinic for Weightloss. Please may we get your name so we can save you. Thank you for your enquiry. We send you information shortly', 'confirmed', null],
  ['Hi yes thank you for contacting me my name is Diana are you interested in selling or personal use', 'confirmed', 'Diana'],
  ['Hi yes it is', 'confirmed', null],
  ['Hi yes it is, how can i help?', 'confirmed', null],
  ['Yes it is. It’s Lalla here. How can I assist Tristan?', 'confirmed', 'Lalla'],
  ["Yes it is. It's Lalla here. How can I assist Tristan?", 'confirmed', 'Lalla'],
  ['Good afternoon,\nI hope you are well?\n\nYes indeed it is\nHow can we help?', 'confirmed', null],
  ["Thanks for getting in touch! I'll ask a representative to respond. Someone will be with", 'bot_autoresponder', null],
  ["Hello Tristan! Yes, you've reached Z U R I. I'm here to help you with our Ayurvedic hair care products or any questions you have about your hair journey.", 'bot_autoresponder', null],
  ['sorry you have the wrong number', 'wrong_number', null],
  ['Please stop messaging me', 'opted_out', null],
  ['Not interested thanks', 'opted_out', null],
  ['Hi', 'needs_review', null],
  ['Who is this?', 'confirmed', null],
];

const POST_PITCH = [
  ['Hi can we maybe chat on Monday ?', 'meeting_request'],
  ['Yes we can talk', 'meeting_request'],
  ['Thank you so Much for reaching out. May I ask which business you worked with?', 'asking_proof'],
  ['I see, I’m not familiar with these brands. Before taking it any further may I ask what you specialize in? Seo, above the line marketing, social media?', 'asking_speciality'],
  ['We are currently working with a marketing company, but let me chat to the team and get back to you', 'has_agency'],
  ['Can you maybe give me a short summary or background first?', 'requested_info'],
  ['You can speak directly with the owner regarding that. Here is her email.', 'referred_decision_maker'],
  ['I am sharing this with my boss and will revert', 'referred_decision_maker'],
  ['Not interested, please remove me', 'not_interested'],
];

test('opener renders in the proven wording', () => {
  assert.equal(
    renderOpener({ brand_name: 'Total Skin and Body' }),
    'Hi there, is this the right contact for Total Skin and Body?',
  );
  assert.equal(
    renderOpener({ brand_name: 'Omnia Wellness & Aesthetic Medicine' }),
    'Hi there, is this the right contact for Omnia Wellness & Aesthetic Medicine?',
  );
});

test('brand names lose legal and branch cruft', () => {
  assert.equal(cleanBrandName('Vital Health Foods (Pty) Ltd - Sandton Branch'), 'Vital Health Foods');
  assert.equal(cleanBrandName('Xtreme Nutrition Canal Walk'), 'Xtreme Nutrition');
  assert.equal(cleanBrandName('Health City'), 'Health City');
  assert.equal(cleanBrandName('The Health Park'), 'The Health Park');
  // A hyphen inside the name is not a branch separator.
  assert.equal(cleanBrandName('Derma-Lab Skincare Factory Shop'), 'Derma-Lab Skincare Factory Shop');
  assert.equal(cleanBrandName('Zero BS Cosmetics'), 'Zero BS Cosmetics');
});

test('opener replies classify as they did in the real transcripts', () => {
  for (const [text, expected] of OPENER_REPLIES) {
    assert.equal(classifyReply(text), expected, `reply: ${JSON.stringify(text.slice(0, 60))}`);
  }
});

test('contact first names are extracted, and only real names', () => {
  for (const [text, , expectedName] of OPENER_REPLIES) {
    assert.equal(extractContactName(text), expectedName, `reply: ${JSON.stringify(text.slice(0, 60))}`);
  }
});

test('post-pitch replies route to the right stage', () => {
  for (const [text, expected] of POST_PITCH) {
    assert.equal(classifyPostPitch(text), expected, `reply: ${JSON.stringify(text.slice(0, 60))}`);
  }
});

test('pitch selects copy for products, clinics and decision-maker routing', () => {
  assert.equal(selectPitchVariant({ business_type: 'ecommerce_product' }), 'product');
  assert.equal(selectPitchVariant({ category: 'Aesthetic clinic' }), 'clinic');
  assert.equal(selectPitchVariant({ business_type: 'retailer_wholesaler' }), 'routing');

  const product = renderPitch({ business_type: 'ecommerce_product', contactName: 'Natasha' });
  const clinic = renderPitch({ business_type: 'clinic_service' });
  const routing = renderPitch({ business_type: 'retailer_wholesaler' });
  assert.ok(product.startsWith('Thank you for confirming Natasha,'));
  assert.match(product, /online sales/);
  assert.match(clinic, /qualified bookings/);
  assert.match(routing, /best person to speak to/);
});

test('website social discovery includes business LinkedIn alongside Meta profiles', () => {
  const socials = extractSocials(`
    <a href="https://www.facebook.com/example.health">Facebook</a>
    <a href="https://instagram.com/example.health">Instagram</a>
    <a href="https://www.linkedin.com/company/example-health/">LinkedIn</a>
  `);
  assert.equal(socials.facebook, 'https://www.facebook.com/example.health');
  assert.equal(socials.instagram, 'https://instagram.com/example.health');
  assert.equal(socials.linkedin, 'https://www.linkedin.com/company/example-health/');
});
