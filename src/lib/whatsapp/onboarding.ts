import { createClient } from '@supabase/supabase-js'
import { sendTextMessage } from '@/lib/whatsapp/meta-api'
import {
  sanitizePhoneForMeta,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'

// Lazy admin client to avoid build crashes
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

/**
 * Sends a plain text message as the bot and logs it in the messages/conversations tables.
 */
export async function sendMessageFromBot(
  userId: string,
  contactId: string,
  conversationId: string,
  text: string,
  accessToken: string
) {
  const db = supabaseAdmin()

  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('phone')
    .eq('id', contactId)
    .single()

  if (contactErr || !contact?.phone) {
    console.error('[onboarding] Contact not found:', contactId, contactErr)
    return
  }

  const sanitized = sanitizePhoneForMeta(contact.phone)
  const { data: config, error: configErr } = await db
    .from('whatsapp_config')
    .select('phone_number_id')
    .eq('user_id', userId)
    .single()

  if (configErr || !config) {
    console.error('[onboarding] WhatsApp config not found:', userId, configErr)
    return
  }

  const attempt = async (phone: string): Promise<string> => {
    const r = await sendTextMessage({
      phoneNumberId: config.phone_number_id,
      accessToken,
      to: phone,
      text,
    })
    return r.messageId
  }

  const variants = phoneVariants(sanitized)
  let workingPhone = sanitized
  let waMessageId = ''
  let lastError: unknown = null
  for (const v of variants) {
    try {
      waMessageId = await attempt(v)
      workingPhone = v
      lastError = null
      break
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!isRecipientNotAllowedError(msg)) throw err
      lastError = err
    }
  }
  if (lastError) throw lastError

  if (workingPhone !== sanitized) {
    await db.from('contacts').update({ phone: workingPhone }).eq('id', contactId)
  }

  // Insert into messages
  await db.from('messages').insert({
    conversation_id: conversationId,
    sender_type: 'bot',
    content_type: 'text',
    content_text: text,
    message_id: waMessageId,
    status: 'sent',
  })

  // Update conversations
  await db
    .from('conversations')
    .update({
      last_message_text: text,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId)
}

/**
 * Handles the stateful interactive onboarding of a new customer over WhatsApp.
 * Returns true if onboarding handled/intercepted the message, false to pass it to regular flows/AI.
 */
export async function handleCustomerOnboarding(
  userId: string,
  contactId: string,
  conversationId: string,
  incomingText: string,
  accessToken: string
): Promise<boolean> {
  const db = supabaseAdmin()

  // 1. Fetch Contact Details
  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('*')
    .eq('id', contactId)
    .single()

  if (contactErr || !contact) {
    console.error('[onboarding] Failed to fetch contact:', contactErr)
    return false
  }

  const cleanPhone = sanitizePhoneForMeta(contact.phone)

  // 2. Check if customer already exists in Sri Vasavi customers table
  const { data: matchedCustomers, error: matchErr } = await db
    .from('customers')
    .select('*')
    .or(`phone.eq.${contact.phone},phone.eq.${cleanPhone}`)
    .eq('is_deleted', false)

  if (matchErr) {
    console.error('[onboarding] Customer match query error:', matchErr)
  }

  if (matchedCustomers && matchedCustomers.length > 0) {
    const customer = matchedCustomers[0]
    // Sync the onboarding status in customer record
    if (!customer.whatsapp_onboarding_completed) {
      await db
        .from('customers')
        .update({ whatsapp_onboarding_completed: true })
        .eq('id', customer.id)
    }

    // Sync contact name with customer name
    if (contact.name !== customer.customer_name) {
      await db
        .from('contacts')
        .update({ name: customer.customer_name })
        .eq('id', contactId)
    }

    // Customer already exists, bypass custom onboarding state machine
    return false
  }

  // 3. Fetch current onboarding state for this contact
  const { data: onboarding, error: onboardingErr } = await db
    .from('whatsapp_onboarding_state')
    .select('*')
    .eq('contact_id', contactId)
    .maybeSingle()

  if (onboardingErr) {
    console.error('[onboarding] Fetch state error:', onboardingErr)
    return false
  }

  const normalizedInput = incomingText.trim()

  // 4. State Machine Routing
  if (!onboarding) {
    // START ONBOARDING
    await db.from('whatsapp_onboarding_state').insert({
      contact_id: contactId,
      state: 'AWAITING_NAME',
    })

    const welcomeMsg =
      `Welcome to *Sri Vasavi Plywoods*! 🪵🌟\n\n` +
      `We are premium suppliers of high-quality Gurjan Plywood, Decorative Laminates, Elegant Veneers, and Interior Hardware fittings.\n\n` +
      `To serve you better, may we know your full name please?`

    await sendMessageFromBot(userId, contactId, conversationId, welcomeMsg, accessToken)
    return true
  }

  switch (onboarding.state) {
    case 'AWAITING_NAME': {
      await db
        .from('whatsapp_onboarding_state')
        .update({
          name: normalizedInput,
          state: 'AWAITING_MOBILE',
          updated_at: new Date().toISOString(),
        })
        .eq('contact_id', contactId)

      const askMobile =
        `Thank you, *${normalizedInput}*! 🙌\n\n` +
        `Could you please share your preferred contact number for billing and estimates?\n\n` +
        `*(Reply 'same' to use this number: ${contact.phone})*`

      await sendMessageFromBot(userId, contactId, conversationId, askMobile, accessToken)
      return true
    }

    case 'AWAITING_MOBILE': {
      const mobile = normalizedInput.toLowerCase() === 'same' ? contact.phone : normalizedInput

      await db
        .from('whatsapp_onboarding_state')
        .update({
          mobile,
          state: 'AWAITING_LOCATION',
          updated_at: new Date().toISOString(),
        })
        .eq('contact_id', contactId)

      const askLocation = `Excellent. Which city or area are you located in? (e.g., Chennai, Bangalore, or a local area name)`

      await sendMessageFromBot(userId, contactId, conversationId, askLocation, accessToken)
      return true
    }

    case 'AWAITING_LOCATION': {
      await db
        .from('whatsapp_onboarding_state')
        .update({
          location: normalizedInput,
          state: 'AWAITING_REQUIREMENT',
          updated_at: new Date().toISOString(),
        })
        .eq('contact_id', contactId)

      const askRequirement =
        `Perfect. What materials are you currently looking for?\n\n` +
        `*(e.g., Gurjan Plywood, 1.2mm Laminates, Veneers, Modular Hardware, or Full Interior materials?)*`

      await sendMessageFromBot(userId, contactId, conversationId, askRequirement, accessToken)
      return true
    }

    case 'AWAITING_REQUIREMENT': {
      // Save details to public.customers table
      const { error: insertErr } = await db.from('customers').insert({
        customer_name: onboarding.name,
        phone: onboarding.mobile,
        address: onboarding.location,
        requirement: normalizedInput,
        sales_stage: 'New Lead',
        priority: 'Medium',
        whatsapp_onboarding_completed: true,
        is_ai_enabled: true,
      })

      if (insertErr) {
        console.error('[onboarding] Failed to save customer details:', insertErr)
      }

      // Sync name in contacts
      await db
        .from('contacts')
        .update({ name: onboarding.name })
        .eq('id', contactId)

      // Onboarding complete, delete the temporary onboarding state
      await db.from('whatsapp_onboarding_state').delete().eq('contact_id', contactId)

      const thanksMsg =
        `Thank you so much, *${onboarding.name}*! Your profile has been successfully registered with **Sri Vasavi Plywoods**! 🗃️✨\n\n` +
        `One of our team experts will reach out to you shortly regarding your requirement: *${normalizedInput}*.\n\n` +
        `We are thrilled to assist you with your premium interior journey! Feel free to chat with us if you need anything else.`

      await sendMessageFromBot(userId, contactId, conversationId, thanksMsg, accessToken)
      return true
    }

    default:
      // Safety bypass
      return false
  }
}
