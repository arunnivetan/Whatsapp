import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { sendTextMessage } from '@/lib/whatsapp/meta-api'
import {
  sanitizePhoneForMeta,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'

// Lazy-loaded Supabase admin client
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

// GET - Daily Birthday Cron Trigger
export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization')
  
  // Optional cron security lock
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized CRON trigger' }, { status: 401 })
  }

  const db = supabaseAdmin()
  const results: any[] = []

  try {
    // 1. Fetch all WhatsApp configurations to process birthdays per active tenant
    const { data: configs, error: configErr } = await db
      .from('whatsapp_config')
      .select('*')
      .eq('status', 'connected')

    if (configErr || !configs || configs.length === 0) {
      return NextResponse.json({
        message: 'No active WhatsApp configurations found.',
        error: configErr?.message,
      })
    }

    // 2. Fetch customers whose birthday month and day match today in Postgres
    // Safe, high-performance timezone extraction
    const { data: birthdayCustomers, error: customerErr } = await db.rpc(
      'get_birthday_customers_today'
    )

    let customersToGreet = birthdayCustomers

    // Fallback if RPC function is not yet installed in Postgres: query directly
    if (customerErr || !birthdayCustomers) {
      console.warn('[cron] RPC not found, falling back to direct select query.');
      
      const { data: fallbackCustomers, error: fallbackErr } = await db
        .from('customers')
        .select('*')
        .eq('is_deleted', false)

      if (fallbackErr) {
        throw fallbackErr
      }

      const today = new Date()
      const todayMonth = today.getMonth() + 1 // 1-indexed
      const todayDay = today.getDate()

      customersToGreet = (fallbackCustomers || []).filter((c: any) => {
        if (!c.birthday) return false
        const bdate = new Date(c.birthday)
        return bdate.getMonth() + 1 === todayMonth && bdate.getDate() === todayDay
      })
    }

    if (!customersToGreet || customersToGreet.length === 0) {
      return NextResponse.json({ message: 'No customer birthdays today.' })
    }

    // 3. Loop through configurations and send greetings
    for (const config of configs) {
      const accessToken = decrypt(config.access_token)
      const phoneId = config.phone_number_id
      const tenantUserId = config.user_id

      for (const customer of customersToGreet) {
        if (!customer.phone) continue

        const sanitized = sanitizePhoneForMeta(customer.phone)
        const name = customer.customer_name || 'Valued Customer'
        
        const wishText =
          `Dear *${name}*, 🎂🎉\n\n` +
          `Warmest birthday wishes from all of us at **Sri Vasavi Plywoods**! 🌳🎈\n\n` +
          `May your day be filled with happiness, and may your home and spaces always stay beautiful, strong, and elegant. We are truly proud and grateful to have you as our valued customer! 🌟\n\n` +
          `Have a wonderful celebration today! 🪵✨`

        // Attempt sending with phone variants support
        const attempt = async (phone: string): Promise<string> => {
          const r = await sendTextMessage({
            phoneNumberId: phoneId,
            accessToken,
            to: phone,
            text: wishText,
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

        if (lastError) {
          console.error(`[cron] Failed to wish customer ${name} (${customer.phone}):`, lastError)
          results.push({ customer: name, status: 'failed', error: String(lastError) })
          continue
        }

        // Sync phone variant in contact if it matched differently
        const { data: baseContact } = await db
          .from('contacts')
          .select('id')
          .eq('phone', customer.phone)
          .eq('user_id', tenantUserId)
          .maybeSingle()

        if (baseContact) {
          // Find or create conversation for this contact
          let { data: conversation } = await db
            .from('conversations')
            .select('id')
            .eq('contact_id', baseContact.id)
            .eq('user_id', tenantUserId)
            .maybeSingle()

          if (!conversation) {
            const { data: newConv } = await db
              .from('conversations')
              .insert({ contact_id: baseContact.id, user_id: tenantUserId })
              .select('id')
              .single()
            conversation = newConv
          }

          if (conversation) {
            // Save message log as 'bot'
            await db.from('messages').insert({
              conversation_id: conversation.id,
              sender_type: 'bot',
              content_type: 'text',
              content_text: wishText,
              message_id: waMessageId,
              status: 'sent',
            })

            // Update conversation last message
            await db
              .from('conversations')
              .update({
                last_message_text: wishText,
                last_message_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              })
              .eq('id', conversation.id)
          }
        }

        // Log the activity to Sri Vasavi's ledger
        await db.from('activities').insert({
          customer_id: customer.id,
          action_type: 'Birthday Wishes',
          old_value: null,
          new_value: 'Sent automated birthday wishes over WhatsApp',
          updated_by: 'System Cron',
        })

        results.push({ customer: name, phone: workingPhone, status: 'success' })
      }
    }

    return NextResponse.json({
      message: `Birthday automation completed. Processed ${results.length} customers.`,
      results,
    })
  } catch (err: any) {
    console.error('[cron] Birthday execution crash:', err)
    return NextResponse.json({ error: 'Birthday CRON execution failed', details: err.message }, { status: 500 })
  }
}
