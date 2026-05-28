"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import type { Contact, Deal, ContactNote, Tag } from "@/types";
import {
  Phone,
  Mail,
  Copy,
  Check,
  User,
  Tag as TagIcon,
  DollarSign,
  StickyNote,
  Plus,
  Sparkles,
  MapPin,
  Layers,
  Receipt,
  Calendar,
  Building2,
  ExternalLink,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { format } from "date-fns";
import { toast } from "sonner";

interface ContactSidebarProps {
  contact: Contact | null;
}

export function ContactSidebar({ contact }: ContactSidebarProps) {
  const [copied, setCopied] = useState(false);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [notes, setNotes] = useState<ContactNote[]>([]);
  const [tags, setTags] = useState<(Tag & { contact_tag_id: string })[]>([]);
  const [newNote, setNewNote] = useState("");
  const [addingNote, setAddingNote] = useState(false);

  // Sri Vasavi CRM integration states
  const [customer, setCustomer] = useState<any>(null);
  const [quotations, setQuotations] = useState<any[]>([]);
  const [payments, setPayments] = useState<any[]>([]);
  const [loadingCRM, setLoadingCRM] = useState(false);
  const [updatingAI, setUpdatingAI] = useState(false);

  const fetchContactData = useCallback(async () => {
    if (!contact) return;

    const supabase = createClient();
    setLoadingCRM(true);

    try {
      // 1. Parallel fetch for base wacrm data
      const [dealsRes, notesRes, tagsRes] = await Promise.all([
        supabase
          .from("deals")
          .select("*, stage:pipeline_stages(*)")
          .eq("contact_id", contact.id)
          .order("created_at", { ascending: false }),
        supabase
          .from("contact_notes")
          .select("*")
          .eq("contact_id", contact.id)
          .order("created_at", { ascending: false }),
        supabase
          .from("contact_tags")
          .select("id, tag_id, tags(*)")
          .eq("contact_id", contact.id),
      ]);

      if (dealsRes.data) setDeals(dealsRes.data);
      if (notesRes.data) setNotes(notesRes.data);
      if (tagsRes.data) {
        const mapped = tagsRes.data
          .filter((ct: any) => ct.tags)
          .map((ct: any) => ({
            ...(ct.tags as Tag),
            contact_tag_id: ct.id as string,
          }));
        setTags(mapped);
      }

      // 2. Query Sri Vasavi Plywoods customers table using clean phone numbers
      const cleanPhone = contact.phone.replace(/\D/g, "");
      const cleanPhoneWithPlus = contact.phone.startsWith("+") ? contact.phone : `+${contact.phone}`;

      const { data: customerData, error: customerErr } = await supabase
        .from("customers")
        .select("*")
        .or(`phone.eq.${contact.phone},phone.eq.${cleanPhone},phone.eq.${cleanPhoneWithPlus}`)
        .eq("is_deleted", false)
        .maybeSingle();

      if (customerErr) {
        console.error("Error fetching matching customer profile:", customerErr);
      }

      if (customerData) {
        setCustomer(customerData);

        // Fetch quotations/estimates history
        const { data: quotesData } = await supabase
          .from("quotations")
          .select("*")
          .eq("customer_id", customerData.id)
          .order("created_at", { ascending: false });

        if (quotesData) setQuotations(quotesData);

        // Fetch ledger payments history
        const { data: paymentsData } = await supabase
          .from("payments")
          .select("*")
          .eq("customer_id", customerData.id)
          .order("created_at", { ascending: false });

        if (paymentsData) setPayments(paymentsData);
      } else {
        setCustomer(null);
        setQuotations([]);
        setPayments([]);
      }
    } catch (err) {
      console.error("Error in fetchContactData:", err);
    } finally {
      setLoadingCRM(false);
    }
  }, [contact]);

  useEffect(() => {
    fetchContactData();
  }, [fetchContactData]);

  const handleCopyPhone = useCallback(async () => {
    if (!contact?.phone) return;
    await navigator.clipboard.writeText(contact.phone);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [contact]);

  const handleAddNote = useCallback(async () => {
    if (!contact || !newNote.trim()) return;
    setAddingNote(true);

    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;

    const { data, error } = await supabase
      .from("contact_notes")
      .insert({
        contact_id: contact.id,
        user_id: user?.id,
        note_text: newNote.trim(),
      })
      .select()
      .single();

    if (!error && data) {
      setNotes((prev) => [data, ...prev]);
      setNewNote("");
      toast.success("Note added successfully.");
    } else {
      toast.error("Failed to add note.");
    }
    setAddingNote(false);
  }, [contact, newNote]);

  // Toggle Gemini AI auto-reply for this customer
  const handleToggleAI = async () => {
    if (!customer) return;
    setUpdatingAI(true);

    const nextState = !customer.is_ai_enabled;
    const supabase = createClient();

    const { error } = await supabase
      .from("customers")
      .update({ is_ai_enabled: nextState })
      .eq("id", customer.id);

    if (!error) {
      setCustomer((prev: any) => ({ ...prev, is_ai_enabled: nextState }));
      toast.success(`Gemini AI auto-replies ${nextState ? "enabled" : "disabled"} for this contact.`);
    } else {
      toast.error("Failed to update AI settings.");
    }
    setUpdatingAI(false);
  };

  // Sync and toggle premium tags in both systems
  const handleToggleCustomerTag = async (tagName: string) => {
    if (!contact) return;
    const supabase = createClient();

    const hasTag = tags.some((t) => t.name === tagName);

    try {
      if (hasTag) {
        // Remove from wacrm contact_tags
        const target = tags.find((t) => t.name === tagName);
        if (target) {
          await supabase.from("contact_tags").delete().eq("id", target.contact_tag_id);
        }

        // Remove from Sri Vasavi customers array
        if (customer) {
          const updatedTags = (customer.tags || []).filter((t: string) => t !== tagName);
          await supabase.from("customers").update({ tags: updatedTags }).eq("id", customer.id);
          setCustomer((prev: any) => ({ ...prev, tags: updatedTags }));
        }

        toast.success(`Removed tag: ${tagName}`);
      } else {
        // Ensure tag exists in base tags table
        const { data: userSession } = await supabase.auth.getSession();
        const userId = userSession.session?.user.id;

        let { data: baseTag } = await supabase
          .from("tags")
          .select("*")
          .eq("name", tagName)
          .maybeSingle();

        if (!baseTag && userId) {
          const colorMap: Record<string, string> = {
            "Interior Designer": "#a855f7", // Purple
            "Contractor": "#3b82f6",       // Blue
            "Dealer": "#f59e0b",           // Amber/Gold
            "Retail Customer": "#10b981",  // Green
          };
          const { data: newTag } = await supabase
            .from("tags")
            .insert({
              user_id: userId,
              name: tagName,
              color: colorMap[tagName] || "#e2e8f0",
            })
            .select()
            .single();
          baseTag = newTag;
        }

        // Add to wacrm contact_tags
        if (baseTag) {
          await supabase.from("contact_tags").insert({
            contact_id: contact.id,
            tag_id: baseTag.id,
          });
        }

        // Add to Sri Vasavi customers array
        if (customer) {
          const updatedTags = [...(customer.tags || []), tagName];
          await supabase.from("customers").update({ tags: updatedTags }).eq("id", customer.id);
          setCustomer((prev: any) => ({ ...prev, tags: updatedTags }));
        }

        toast.success(`Added tag: ${tagName}`);
      }

      // Re-fetch all tag links
      const { data: tagsRes } = await supabase
        .from("contact_tags")
        .select("id, tag_id, tags(*)")
        .eq("contact_id", contact.id);

      if (tagsRes) {
        const mapped = tagsRes
          .filter((ct: any) => ct.tags)
          .map((ct: any) => ({
            ...(ct.tags as Tag),
            contact_tag_id: ct.id as string,
          }));
        setTags(mapped);
      }
    } catch (err) {
      console.error("Tag sync error:", err);
      toast.error("Failed to update tags.");
    }
  };

  if (!contact) {
    return (
      <div className="flex h-full w-80 items-center justify-center border-l border-slate-800 bg-slate-900">
        <p className="text-sm text-slate-500">Select a conversation</p>
      </div>
    );
  }

  const displayName = contact.name || contact.phone;
  const initials = displayName.charAt(0).toUpperCase();

  return (
    <div className="flex h-full w-80 flex-col border-l border-slate-800 bg-slate-900">
      <ScrollArea className="flex-1">
        <div className="p-4 space-y-6">
          {/* Contact Header */}
          <div className="flex flex-col items-center text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-slate-700 text-lg font-semibold text-white ring-2 ring-primary/20">
              {contact.avatar_url ? (
                <img
                  src={contact.avatar_url}
                  alt={displayName}
                  className="h-16 w-16 rounded-full object-cover"
                />
              ) : (
                initials
              )}
            </div>
            <h3 className="mt-3 text-sm font-semibold text-white leading-tight">
              {displayName}
            </h3>
            {contact.company && (
              <p className="text-xs text-slate-400 mt-0.5">{contact.company}</p>
            )}
          </div>

          {/* Quick Actions & Communication */}
          <div className="space-y-1.5 bg-slate-800/40 rounded-xl p-2 border border-slate-800">
            <button
              onClick={handleCopyPhone}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-xs text-slate-300 transition-colors hover:bg-slate-800"
            >
              <Phone className="h-3.5 w-3.5 text-slate-500" />
              <span className="flex-1 text-left truncate">{contact.phone}</span>
              {copied ? (
                <Check className="h-3 w-3 text-primary" />
              ) : (
                <Copy className="h-3 w-3 text-slate-600" />
              )}
            </button>

            {contact.email && (
              <div className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-xs text-slate-300">
                <Mail className="h-3.5 w-3.5 text-slate-500" />
                <span className="truncate flex-1 text-left">{contact.email}</span>
              </div>
            )}
          </div>

          {/* Sri Vasavi Plywoods Premium CRM Profile */}
          <div className="border border-amber-500/20 bg-amber-500/5 rounded-xl p-3.5 space-y-4">
            <div className="flex items-center justify-between">
              <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-amber-500">
                <Building2 className="h-4 w-4" />
                Vasavi CRM Profile
              </h4>
              {loadingCRM && <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-500" />}
            </div>

            {customer ? (
              <div className="space-y-4 text-xs">
                {/* Stage and Priority */}
                <div className="flex flex-wrap gap-1.5">
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 font-medium border text-[10px]",
                      customer.sales_stage === "Converted"
                        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                        : "border-amber-500/30 bg-amber-500/10 text-amber-400"
                    )}
                  >
                    {customer.sales_stage || "New Lead"}
                  </span>
                  <span className="rounded-full px-2 py-0.5 font-medium border border-slate-700 bg-slate-800 text-slate-300 text-[10px]">
                    Priority: {customer.priority || "Medium"}
                  </span>
                </div>

                {/* AI Toggle */}
                <div className="flex items-center justify-between rounded-lg bg-slate-800/80 p-2.5 border border-slate-700">
                  <div className="flex items-center gap-1.5">
                    <Sparkles className="h-3.5 w-3.5 text-purple-400" />
                    <div className="leading-none">
                      <p className="font-semibold text-white text-[11px]">Gemini AI Assistant</p>
                      <p className="text-[9px] text-slate-400 mt-0.5">Automate FAQs & suggestions</p>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 w-7 p-0 rounded-full hover:bg-slate-700"
                    onClick={handleToggleAI}
                    disabled={updatingAI}
                  >
                    {customer.is_ai_enabled ? (
                      <Check className="h-4 w-4 text-primary" />
                    ) : (
                      <Plus className="h-4 w-4 text-slate-500" />
                    )}
                  </Button>
                </div>

                {/* Details */}
                <div className="space-y-2 text-slate-300 bg-slate-800/40 p-2.5 rounded-lg border border-slate-800">
                  <div className="flex items-start gap-2">
                    <MapPin className="h-3.5 w-3.5 text-slate-500 shrink-0 mt-0.5" />
                    <div>
                      <p className="text-[10px] text-slate-500 leading-none">Location / Address</p>
                      <p className="mt-1 leading-normal">{customer.address || "Not specified"}</p>
                    </div>
                  </div>

                  <div className="flex items-start gap-2 border-t border-slate-800/80 pt-2">
                    <Layers className="h-3.5 w-3.5 text-slate-500 shrink-0 mt-0.5" />
                    <div>
                      <p className="text-[10px] text-slate-500 leading-none">Material Requirements</p>
                      <p className="mt-1 leading-normal font-medium text-white">
                        {customer.requirement || "Not specified"}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Outstanding Balance Ledger */}
                <div className="space-y-1.5 bg-slate-800/60 p-2.5 rounded-lg border border-slate-700">
                  <div className="flex items-center justify-between text-slate-400">
                    <span>Total Billing:</span>
                    <span className="font-medium text-slate-200 tabular-nums">
                      ₹{customer.amount?.toLocaleString() || 0}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-slate-400">
                    <span>Paid Advance:</span>
                    <span className="font-medium text-emerald-400 tabular-nums">
                      ₹{customer.advance_paid?.toLocaleString() || 0}
                    </span>
                  </div>
                  <div className="flex items-center justify-between border-t border-slate-700 pt-1.5 text-white font-semibold">
                    <span className="flex items-center gap-1">
                      Outstanding:
                    </span>
                    <span className="text-amber-500 tabular-nums">
                      ₹{customer.pending_amount?.toLocaleString() || 0}
                    </span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-center py-2 space-y-1 text-slate-400 text-xs">
                <p>No Vasavi CRM customer record found.</p>
                <p className="text-[10px] text-slate-600">The customer will register automatically upon completing the WhatsApp onboarding flow.</p>
              </div>
            )}
          </div>

          {/* Customer Type Tags (Sri Vasavi specified categorizations) */}
          <div className="space-y-2">
            <div className="flex items-center gap-1.5 px-1 text-xs font-semibold uppercase tracking-wider text-slate-500">
              <TagIcon className="h-3.5 w-3.5" />
              Customer Segments
            </div>
            <div className="flex flex-wrap gap-1.5">
              {["Interior Designer", "Contractor", "Dealer", "Retail Customer"].map((cat) => {
                const isActive = tags.some((t) => t.name === cat);
                const colorMap: Record<string, string> = {
                  "Interior Designer": "border-purple-500/40 text-purple-400 bg-purple-500/5",
                  "Contractor": "border-blue-500/40 text-blue-400 bg-blue-500/5",
                  "Dealer": "border-amber-500/40 text-amber-400 bg-amber-500/5",
                  "Retail Customer": "border-emerald-500/40 text-emerald-400 bg-emerald-500/5",
                };
                return (
                  <button
                    key={cat}
                    onClick={() => handleToggleCustomerTag(cat)}
                    className={cn(
                      "rounded-full border px-2.5 py-1 text-[10px] font-semibold transition-all outline-none",
                      isActive
                        ? colorMap[cat]
                        : "border-slate-800 text-slate-400 hover:border-slate-700 hover:text-slate-200 bg-slate-900"
                    )}
                  >
                    {isActive && <Check className="inline h-2.5 w-2.5 mr-1" />}
                    {cat}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Quotations / Estimates History */}
          {customer && (
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 px-1 text-xs font-semibold uppercase tracking-wider text-slate-500">
                <Receipt className="h-3.5 w-3.5" />
                Quotations ({quotations.length})
              </div>
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {quotations.length === 0 ? (
                  <p className="px-1 text-xs text-slate-600">No quotation history</p>
                ) : (
                  quotations.map((quote) => (
                    <div
                      key={quote.id}
                      className="rounded-xl border border-slate-800 bg-slate-950/60 p-2.5 text-xs space-y-1.5 hover:border-slate-700 transition-colors"
                    >
                      <div className="flex items-center justify-between font-semibold text-white">
                        <span>{quote.quotation_number}</span>
                        <span className="text-amber-500 tabular-nums">
                          ₹{quote.total_amount?.toLocaleString() || 0}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-[10px] text-slate-500">
                        <span className="flex items-center gap-1">
                          <Calendar className="h-3 w-3" />
                          {format(new Date(quote.created_at), "MMM d, yyyy")}
                        </span>
                        <span
                          className={cn(
                            "rounded px-1 text-[9px] uppercase font-bold",
                            quote.status === "Approved"
                              ? "bg-emerald-500/10 text-emerald-400"
                              : "bg-slate-800 text-slate-400"
                          )}
                        >
                          {quote.status}
                        </span>
                      </div>
                      {quote.file_url && (
                        <a
                          href={quote.file_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 text-[10px] text-primary hover:underline font-medium"
                        >
                          <ExternalLink className="h-3 w-3" />
                          View PDF Estimate
                        </a>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* Ledger Payment Receipts */}
          {customer && (
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 px-1 text-xs font-semibold uppercase tracking-wider text-slate-500">
                <Receipt className="h-3.5 w-3.5" />
                Payments ({payments.length})
              </div>
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {payments.length === 0 ? (
                  <p className="px-1 text-xs text-slate-600">No payment receipts</p>
                ) : (
                  payments.map((payment) => (
                    <div
                      key={payment.id}
                      className="rounded-xl bg-slate-850 p-2.5 text-xs space-y-1"
                    >
                      <div className="flex items-center justify-between font-semibold">
                        <span className="text-emerald-400 tabular-nums">
                          + ₹{payment.amount_paid?.toLocaleString()}
                        </span>
                        <span className="text-[10px] text-slate-500 font-normal">
                          {payment.payment_mode}
                        </span>
                      </div>
                      {payment.note && (
                        <p className="text-[10px] text-slate-400 leading-normal italic">
                          "{payment.note}"
                        </p>
                      )}
                      <p className="text-[9px] text-slate-600 mt-1">
                        Received: {format(new Date(payment.created_at), "MMM d, yyyy HH:mm")}
                      </p>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* CRM Internal Notes */}
          <div className="space-y-2.5">
            <div className="flex items-center gap-1.5 px-1 text-xs font-semibold uppercase tracking-wider text-slate-500">
              <StickyNote className="h-3.5 w-3.5" />
              CRM Conversation Notes
            </div>
            <div className="flex gap-2">
              <textarea
                value={newNote}
                onChange={(e) => setNewNote(e.target.value)}
                placeholder="Write a custom chat note..."
                rows={2}
                className="flex-1 resize-none rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-white placeholder-slate-500 outline-none focus:border-primary/50"
              />
              <Button
                size="sm"
                className="h-auto bg-primary px-2 hover:bg-primary/90 text-primary-foreground"
                onClick={handleAddNote}
                disabled={!newNote.trim() || addingNote}
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </div>

            <div className="space-y-2 max-h-48 overflow-y-auto">
              {notes.map((note) => (
                <div
                  key={note.id}
                  className="rounded-xl bg-slate-800 p-2.5 text-xs space-y-1"
                >
                  <p className="whitespace-pre-wrap text-slate-300 leading-normal">
                    {note.note_text}
                  </p>
                  <p className="text-[9px] text-slate-600">
                    {format(new Date(note.created_at), "MMM d, yyyy HH:mm")}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
