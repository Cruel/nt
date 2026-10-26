// Cardinal rules and number formatting are pinned authoring-compiler metadata.
// Cardinal expressions: Unicode CLDR plurals.xml © 1991-2025 Unicode, Inc.
// SPDX-License-Identifier: Unicode-3.0
// Keep these sources in sync with editor/src/shared/cldr-cardinal-rules.ts and
// localePresentationMetadata() in editor/src/shared/authoring-message-lowering.ts.
#pragma once
#include <string_view>

namespace noveltea::cli::locale_data {
inline constexpr std::string_view cardinal_sources = R"NTCARD(
bm bo dz hnj id ig ii in ja jbo jv jw kde kea km ko lkt lo ms my nqo osa root sah ses sg su th to tpi wo yo yue zh|
am as bn doi fa gu hi kn kok kok_Latn pcm tg vi zu|one=>i = 0 or n = 1
ff hy kab|one=>i = 0,1
ast de en et fi fy ia ie io ji lij nl sc sv sw ur yi|one=>i = 1 and v = 0
si|one=>n = 0,1 or i = 0 and f = 1
ak bho csw guw ln mg nso pa ti wa|one=>n = 0..1
tzm|one=>n = 0..1 or n = 11..99
af an asa az bal bem bez bg brx ce cgg chr ckb dv ee el eo eu fo fur gsw ha haw hu jgo jmc ka kaj kcg kk kkj kl ks ksb ku ky lb lg mas mgo ml mn mr nah nb nd ne nn nnh no nr ny nyn om or os pap ps rm rof rwk saq sd sdh seh sn so sq ss ssy st syr ta te teo tig tk tn tr ts ug uz ve vo vun wae xh xog|one=>n = 1
da|one=>n = 1 or t != 0 and i = 0,1
is|one=>t = 0 and i % 10 = 1 and i % 100 != 11 or t % 10 = 1 and t % 100 != 11
mk|one=>v = 0 and i % 10 = 1 and i % 100 != 11 or f % 10 = 1 and f % 100 != 11
ceb fil tl|one=>v = 0 and i = 1,2,3 or v = 0 and i % 10 != 4,6,9 or v != 0 and f % 10 != 4,6,9
lv prg|zero=>n % 10 = 0 or n % 100 = 11..19 or v = 2 and f % 100 = 11..19|one=>n % 10 = 1 and n % 100 != 11 or v = 2 and f % 10 = 1 and f % 100 != 11 or v != 2 and f % 10 = 1
lag|zero=>n = 0|one=>i = 0,1 and n != 0
blo cv ksh|zero=>n = 0|one=>n = 1
he iw|one=>i = 1 and v = 0 or i = 0 and v != 0|two=>i = 2 and v = 0
iu naq sat se sma smi smj smn sms|one=>n = 1|two=>n = 2
shi|one=>i = 0 or n = 1|few=>n = 2..10
mo ro|one=>i = 1 and v = 0|few=>v != 0 or n = 0 or n != 1 and n % 100 = 1..19
bs hr sh sr|one=>v = 0 and i % 10 = 1 and i % 100 != 11 or f % 10 = 1 and f % 100 != 11|few=>v = 0 and i % 10 = 2..4 and i % 100 != 12..14 or f % 10 = 2..4 and f % 100 != 12..14
fr pt|one=>i = 0..1|many=>e = 0 and i != 0 and i % 1000000 = 0 and v = 0 or e != 0..5
ca gl it lld pt_PT scn vec|one=>i = 1 and v = 0|many=>e = 0 and i != 0 and i % 1000000 = 0 and v = 0 or e != 0..5
es|one=>n = 1|many=>e = 0 and i != 0 and i % 1000000 = 0 and v = 0 or e != 0..5
gd|one=>n = 1,11|two=>n = 2,12|few=>n = 3..10,13..19
sl|one=>v = 0 and i % 100 = 1|two=>v = 0 and i % 100 = 2|few=>v = 0 and i % 100 = 3..4 or v != 0
dsb hsb|one=>v = 0 and i % 100 = 1 or f % 100 = 1|two=>v = 0 and i % 100 = 2 or f % 100 = 2|few=>v = 0 and i % 100 = 3..4 or f % 100 = 3..4
cs sk|one=>i = 1 and v = 0|few=>i = 2..4 and v = 0|many=>v != 0
pl|one=>i = 1 and v = 0|few=>v = 0 and i % 10 = 2..4 and i % 100 != 12..14|many=>v = 0 and i != 1 and i % 10 = 0..1 or v = 0 and i % 10 = 5..9 or v = 0 and i % 100 = 12..14
be|one=>n % 10 = 1 and n % 100 != 11|few=>n % 10 = 2..4 and n % 100 != 12..14|many=>n % 10 = 0 or n % 10 = 5..9 or n % 100 = 11..14
lt|one=>n % 10 = 1 and n % 100 != 11..19|few=>n % 10 = 2..9 and n % 100 != 11..19|many=>f != 0
ru uk|one=>v = 0 and i % 10 = 1 and i % 100 != 11|few=>v = 0 and i % 10 = 2..4 and i % 100 != 12..14|many=>v = 0 and i % 10 = 0 or v = 0 and i % 10 = 5..9 or v = 0 and i % 100 = 11..14
sgs|one=>n % 10 = 1 and n % 100 != 11|two=>n = 2|few=>n != 2 and n % 10 = 2..9 and n % 100 != 11..19|many=>f != 0
br|one=>n % 10 = 1 and n % 100 != 11,71,91|two=>n % 10 = 2 and n % 100 != 12,72,92|few=>n % 10 = 3..4,9 and n % 100 != 10..19,70..79,90..99|many=>n != 0 and n % 1000000 = 0
mt|one=>n = 1|two=>n = 2|few=>n = 0 or n % 100 = 3..10|many=>n % 100 = 11..19
ga|one=>n = 1|two=>n = 2|few=>n = 3..6|many=>n = 7..10
gv|one=>v = 0 and i % 10 = 1|two=>v = 0 and i % 10 = 2|few=>v = 0 and i % 100 = 0,20,40,60,80|many=>v != 0
kw|zero=>n = 0|one=>n = 1|two=>n % 100 = 2,22,42,62,82 or n % 1000 = 0 and n % 100000 = 1000..20000,40000,60000,80000 or n != 0 and n % 1000000 = 100000|few=>n % 100 = 3,23,43,63,83|many=>n != 1 and n % 100 = 1,21,41,61,81
ar ars|zero=>n = 0|one=>n = 1|two=>n = 2|few=>n % 100 = 3..10|many=>n % 100 = 11..99
cy|zero=>n = 0|one=>n = 1|two=>n = 2|few=>n = 3|many=>n = 6
)NTCARD";
inline constexpr std::string_view number_format_sources = R"NTNUM(
bm bo hnj ig ii ja jbo kde km ko lkt ms osa root th to tpi yo yue zh am doi kn pcm zu en io ji sw ur yi si ak csw guw mg nso ti wa an asa bal bem bez ce cgg chr dv ee ha haw jmc kaj kcg ksb lg mas mgo mn nah nd nr ny nyn om pap rof rwk saq sdh sn so ss ssy st syr teo tig ts ug ve vo vun xog ceb fil tl lag he iw iu naq sma smi smj sms lld gd sgs mt ga gv kw ar cy en-us en-gb es-mx zh-hans zh-hant zh-tw zh-cn en-arab ur-pk|{"decimalSeparator":".","groupSeparator":",","primaryGroupSize":3,"secondaryGroupSize":3,"digits":["0","1","2","3","4","5","6","7","8","9"]}
dz|{"decimalSeparator":".","groupSeparator":",","primaryGroupSize":3,"secondaryGroupSize":2,"digits":["༠","༡","༢","༣","༤","༥","༦","༧","༨","༩"]}
id in jv jw lo sg su wo vi ast de fy ia lij nl sc ln az el eu fo fur jgo kkj kl ku lb nnh seh tr da is mk mo ro bs hr sh sr pt ca gl it scn es sl dsb hsb pt-br es-es ar-ma sr-latn sr-cyrl az-arab|{"decimalSeparator":",","groupSeparator":".","primaryGroupSize":3,"secondaryGroupSize":3,"digits":["0","1","2","3","4","5","6","7","8","9"]}
kea sah tg ff hy kab et fi ie sv tzm af bg hu ka kk ky nb nn no os sq tk uz lv prg blo cv ksh se smn shi pt-pt cs sk pl be lt ru uk br fr-ca|{"decimalSeparator":",","groupSeparator":" ","primaryGroupSize":3,"secondaryGroupSize":3,"digits":["0","1","2","3","4","5","6","7","8","9"]}
my|{"decimalSeparator":".","groupSeparator":",","primaryGroupSize":3,"secondaryGroupSize":3,"digits":["၀","၁","၂","၃","၄","၅","၆","၇","၈","၉"]}
nqo|{"decimalSeparator":".","groupSeparator":"،","primaryGroupSize":3,"secondaryGroupSize":3,"digits":["߀","߁","߂","߃","߄","߅","߆","߇","߈","߉"]}
ses xh|{"decimalSeparator":".","groupSeparator":" ","primaryGroupSize":3,"secondaryGroupSize":3,"digits":["0","1","2","3","4","5","6","7","8","9"]}
as bn bn-bd|{"decimalSeparator":".","groupSeparator":",","primaryGroupSize":3,"secondaryGroupSize":2,"digits":["০","১","২","৩","৪","৫","৬","৭","৮","৯"]}
fa ks ps fa-ir pa-arab|{"decimalSeparator":"٫","groupSeparator":"٬","primaryGroupSize":3,"secondaryGroupSize":3,"digits":["۰","۱","۲","۳","۴","۵","۶","۷","۸","۹"]}
gu hi kok kok-latn pa brx ml or ta te en-in hi-in|{"decimalSeparator":".","groupSeparator":",","primaryGroupSize":3,"secondaryGroupSize":2,"digits":["0","1","2","3","4","5","6","7","8","9"]}
bho|{"decimalSeparator":".","groupSeparator":",","primaryGroupSize":3,"secondaryGroupSize":3,"digits":["०","१","२","३","४","५","६","७","८","९"]}
ckb ars ar-eg|{"decimalSeparator":"٫","groupSeparator":"٬","primaryGroupSize":3,"secondaryGroupSize":3,"digits":["٠","١","٢","٣","٤","٥","٦","٧","٨","٩"]}
eo rm fr vec fr-fr|{"decimalSeparator":",","groupSeparator":" ","primaryGroupSize":3,"secondaryGroupSize":3,"digits":["0","1","2","3","4","5","6","7","8","9"]}
gsw tn de-ch|{"decimalSeparator":".","groupSeparator":"'","primaryGroupSize":3,"secondaryGroupSize":3,"digits":["0","1","2","3","4","5","6","7","8","9"]}
mr ne|{"decimalSeparator":".","groupSeparator":",","primaryGroupSize":3,"secondaryGroupSize":2,"digits":["०","१","२","३","४","५","६","७","८","९"]}
sd|{"decimalSeparator":".","groupSeparator":"٬","primaryGroupSize":3,"secondaryGroupSize":3,"digits":["٠","١","٢","٣","٤","٥","٦","٧","٨","٩"]}
wae|{"decimalSeparator":",","groupSeparator":"'","primaryGroupSize":3,"secondaryGroupSize":3,"digits":["0","1","2","3","4","5","6","7","8","9"]}
sat|{"decimalSeparator":".","groupSeparator":",","primaryGroupSize":3,"secondaryGroupSize":3,"digits":["᱐","᱑","᱒","᱓","᱔","᱕","᱖","᱗","᱘","᱙"]}
)NTNUM";
inline constexpr std::string_view rtl_locales =
    R"NTRTL(nqo fa ji ur yi bal ckb dv ks ps sd sdh syr ug he iw ar ars ar-eg ar-ma fa-ir pa-arab az-arab en-arab ur-pk)NTRTL";
} // namespace noveltea::cli::locale_data
