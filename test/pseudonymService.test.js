import { describe, it, expect, beforeAll, vi } from 'vitest'
import { freshDb } from './helpers/db.js'

// Capture every prompt sent to Claude and echo back a reply that uses the codes.
const sent = []
let reply = ''
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    constructor () {
      this.messages = {
        create: async params => {
          sent.push(params)
          return { content: [{ type: 'text', text: reply }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }
        }
      }
    }
  }
}))

let pseudo, ai

const client = {
  id: 7,
  first_name: 'Aisha',
  last_name: 'Khan',
  preferred_name: 'Ash',
  ndis_number: '430 123 456',
  phone: '0412 345 678',
  email: 'aisha@example.com',
  plan_manager_name: 'Mary Jane Brown',
  emergency_contact_name: 'Will Khan'
}

beforeAll(async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key'
  await freshDb()
  pseudo = await import('../server/services/pseudonymService.js')
  ai = await import('../server/services/aiService.js')
})

describe('pseudonymService', () => {
  it('gives each participant a stable, distinct code', () => {
    const a = pseudo.participantCode(7)
    expect(a).toMatch(/^PT-[A-Z2-9]{5}$/)
    expect(pseudo.participantCode(7)).toBe(a)
    expect(pseudo.participantCode(8)).not.toBe(a)
  })

  it('masks names and identifiers, and unmasks them back', () => {
    const p = pseudonymiser()
    const text = 'Ash (Aisha Khan, NDIS 430-123-456) called Mary Jane Brown on 0412345678; mary later emailed AISHA@example.com. Will Khan said he will visit.'
    const masked = p.mask(text)
    for (const leak of ['Ash', 'Aisha', 'Khan', 'Mary', 'Brown', '430', '0412', 'example.com']) {
      expect(masked).not.toContain(leak)
    }
    // "will" the verb is left alone; "Will" the contact is masked
    expect(masked).toContain('he will visit')
    expect(p.unmask(masked)).toBe('Ash (Aisha Khan, NDIS 430 123 456) called Mary Jane Brown on 0412 345 678; Mary later emailed aisha@example.com. Will Khan said he will visit.')
  })

  it('does not mangle words that merely contain a name', () => {
    const p = pseudonymiser()
    expect(p.mask('We washed the ashtray.')).toBe('We washed the ashtray.')
  })

  it('restores possessives and leaves unrelated codes untouched', () => {
    const p = pseudonymiser()
    expect(p.unmask(`${p.code}'s goals`)).toBe("Ash's goals")
    expect(p.unmask('PT-ZZZZZ said hi')).toBe('PT-ZZZZZ said hi')
  })

  function pseudonymiser () { return pseudo.pseudonymiserFor(client) }
})

describe('aiService with a pseudonymiser', () => {
  it('never sends the participant name to Claude and restores it in the draft', async () => {
    const p = pseudo.pseudonymiserFor(client)
    sent.length = 0
    reply = `I supported ${p.code} ${p.code}-S to the shops. ${p.code} was happy.`
    const { body } = await ai.draftShiftNote({
      clientLabel: p.label,
      pseudonym: p,
      shiftDate: '2026-09-01',
      supportProvided: '- took Ash shopping\n- aisha chose her groceries',
      participantResponse: 'Aisha Khan was happy'
    }, null)
    const wire = JSON.stringify(sent)
    expect(wire).not.toMatch(/ash|aisha|khan/i)
    expect(body).toBe('I supported Ash Khan to the shops. Ash was happy.')
  })

  it('masks the agreement questionnaire', async () => {
    const p = pseudo.pseudonymiserFor(client)
    sent.length = 0
    reply = `Participant: ${p.code}-G ${p.code}-S (NDIS ${p.code}-N)`
    const body = await ai.draftAgreement({
      clientLabel: p.label,
      pseudonym: p,
      questionnaire: { participant_name: 'Aisha Khan', ndis_number: '430123456' }
    }, null)
    const wire = JSON.stringify(sent)
    expect(wire).not.toMatch(/aisha|khan|430123456/i)
    expect(body).toBe('Participant: Aisha Khan (NDIS 430 123 456)')
  })
})
