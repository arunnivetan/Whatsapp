-- ============================================================================
-- SRI VASAVI PLYWOODS - WHATSAPP INTEGRATION & CRM ADDONS
-- Safe, idempotent SQL script — execute directly in your Supabase SQL Editor.
-- ============================================================================

-- 1. Extend existing public.customers table if needed
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS birthday DATE;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS whatsapp_onboarding_completed BOOLEAN DEFAULT FALSE;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS is_ai_enabled BOOLEAN DEFAULT TRUE;

-- 2. Create whatsapp_onboarding_state table to track interactive onboarding steps
CREATE TABLE IF NOT EXISTS public.whatsapp_onboarding_state (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contact_id UUID REFERENCES public.contacts(id) ON DELETE CASCADE,
    state TEXT NOT NULL, -- 'AWAITING_NAME', 'AWAITING_MOBILE', 'AWAITING_LOCATION', 'AWAITING_REQUIREMENT', 'COMPLETED'
    name TEXT,
    mobile TEXT,
    location TEXT,
    requirement TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    UNIQUE(contact_id)
);

-- 3. Enable Row Level Security (RLS)
ALTER TABLE public.whatsapp_onboarding_state ENABLE ROW LEVEL SECURITY;

-- 4. Create RLS policies (Backend engine uses service_role, but allow authenticated users to view)
DROP POLICY IF EXISTS "Allow authenticated users all operations on onboarding state" ON public.whatsapp_onboarding_state;
CREATE POLICY "Allow authenticated users all operations on onboarding state" 
    ON public.whatsapp_onboarding_state 
    FOR ALL 
    TO authenticated 
    USING (true) 
    WITH CHECK (true);

-- 5. Attach updated_at trigger (reusing function from migration 001)
DROP TRIGGER IF EXISTS set_updated_at ON public.whatsapp_onboarding_state;
CREATE TRIGGER set_updated_at 
    BEFORE UPDATE ON public.whatsapp_onboarding_state 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- 6. Add daily birthday customers helper function
CREATE OR REPLACE FUNCTION public.get_birthday_customers_today()
RETURNS SETOF public.customers
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    SELECT * FROM public.customers
    WHERE EXTRACT(MONTH FROM birthday) = EXTRACT(MONTH FROM CURRENT_DATE)
      AND EXTRACT(DAY FROM birthday) = EXTRACT(DAY FROM CURRENT_DATE)
      AND is_deleted = false;
END;
$$;

