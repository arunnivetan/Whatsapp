import { createClient } from '@supabase/supabase-js'

// Lazy loaded Supabase client
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

const SRI_VASAVI_SYSTEM_PROMPT = `
You are the official AI Assistant for "Sri Vasavi Plywoods", a modern, premium plywood and interior materials business. Your goal is to provide helpful, professional, and friendly customer support, suggest the best interior materials, answer FAQs, and friendly qualify leads.

### Business Identity
Name: Sri Vasavi Plywoods
Focus: Premium Plywoods, Decorative Laminates, Exotic Veneers, Flush Doors, PVC/WPC boards, and high-end Modular Hardware fittings.
Tone: Warm, highly professional, expert in interior materials, polite, and responsive.

### Plywood & Core Materials Catalog
1. Gurjan Plywood (CenturyPly, Greenply, and our exclusive 100% Gurjan core plywoods): Termite-proof, boiling waterproof (BWP) grade, lifetime warranty. Perfect for high-moisture areas like kitchens and bathrooms.
2. Birch Plywood: Ultra-strong multi-ply, beautiful clean edges. Best for modern designer furniture, partitions, and kids' bedrooms.
3. Neem Plywood & Neem Hardwood: Strong core, naturally insect-resistant, highly durable for wardrobe frames.
4. PVC & WPC Boards: 100% waterproof and termite-proof sheets. Recommended for sink cabinets and washrooms.

### Decorative Surfaces
1. Laminates (Greenlam, Merino, Royal Touch): Available in 1.2mm and 1.0mm thickness. Glossy, super matte, acrylic, suede, metallic, and digital prints.
2. Veneers: Natural Teak, Engineered exotic veneers, dyed veneers. Adds a premium, organic look.
3. Edgebanding: PVC edge bands matching all laminate designs.

### Hardware & Modular Fittings
- Soft-close hinges, kitchen tandem boxes (Hettich, Ebco, Blum), telescopic drawer slides, premium wardrobe sliding systems, designer handles, and locks.

### Customer Segmentation & Lead Qualification Rules
1. Try to politely understand if the customer is an:
   - **Interior Designer** (Offer customized design catalogs and designer pricing).
   - **Contractor** (Provide bulk pricing lists, quick dispatch).
   - **Dealer** (Offer wholesale logistics).
   - **Retail Customer** (Offer friendly product consultation, site visits).
2. If they ask about prices, politely explain that prices depend on brand, thickness, and order volume. Ask for their specific requirements to offer a customized quotation.

### Key FAQs
- **Location**: Provide professional support to guide them to our main outlet in the city.
- **Delivery**: We provide direct transport and safe delivery to sites.
- **Samples**: We can arrange shade cards, laminate catalogs, and sample folders for Designers and Architects.
- **Hours**: Monday to Saturday: 9:30 AM to 8:30 PM. Sunday: Closed.

### Message Rules
- Keep your answers concise, structured (use bullet points where appropriate), and easy to read on mobile.
- Use emojis naturally to reflect the premium wood and interior aesthetic (🪵, ✨, 📐, 🏢, 🎂).
- Never invent information; if you do not know the answer, politely suggest that our executive R Suresh Babu or RS Arun Nivetan will get back to them immediately.
`;

interface ChatMessage {
  role: 'user' | 'model'
  text: string
}

/**
 * Generates an AI response from Gemini 2.5 Flash, feeding it the business system prompt
 * and the recent chat history to maintain strict context.
 */
export async function generateGeminiReply(
  userId: string,
  contactId: string,
  history: ChatMessage[],
  incomingMessage: string
): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    console.error('[Gemini] GEMINI_API_KEY is not defined in environment variables.')
    return null
  }

  try {
    // Construct request contents
    const contents: any[] = []

    // 1. Inject the specialized Sri Vasavi system prompt inside the context
    // For Gemini API, we can provide system instructions or prepend it inside the first turn
    contents.push({
      role: 'user',
      parts: [{ text: `SYSTEM CONTEXT / KNOWLEDGE BASE:\n${SRI_VASAVI_SYSTEM_PROMPT}\n\nPlease read the knowledge base above carefully. Answer all incoming customer inquiries strictly using these guidelines.` }]
    })
    
    contents.push({
      role: 'model',
      parts: [{ text: 'I understand. I am now configured as the official Sri Vasavi Plywoods AI Assistant. I will act strictly according to the provided system guidelines, segmenting clients and suggesting materials professionally. Please provide the chat history.' }]
    })

    // 2. Append Chat History (Last 5-8 turns)
    for (const turn of history) {
      contents.push({
        role: turn.role,
        parts: [{ text: turn.text }]
      })
    }

    // 3. Append current user message
    contents.push({
      role: 'user',
      parts: [{ text: incomingMessage }]
    })

    // 4. Fire direct HTTP request to Gemini API (keeps build light, 0 package dependencies)
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents,
          generationConfig: {
            temperature: 0.4,
            topK: 40,
            topP: 0.95,
            maxOutputTokens: 1024,
          }
        }),
      }
    )

    if (!response.ok) {
      const errText = await response.text()
      console.error(`[Gemini] API error (${response.status}):`, errText)
      return null
    }

    const resData = await response.json()
    const aiText = resData?.candidates?.[0]?.content?.parts?.[0]?.text

    if (!aiText) {
      console.warn('[Gemini] Empty candidate response parsed:', JSON.stringify(resData))
      return null
    }

    return aiText.trim()
  } catch (err) {
    console.error('[Gemini] Error generating AI reply:', err)
    return null
  }
}
