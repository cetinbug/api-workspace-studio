# API Workspace Studio — ürün gereksinimleri

**Durum:** İnceleme taslağı

**Tarih:** 2026-09-23

**Temel:** [Bruno](https://github.com/usebruno/bruno) açık kaynak kodundan fork

## 1. Amaç

Kullanıcı, API isteklerini masaüstü arayüzünden oluşturup çalıştırabilmeli; ekipçe paylaşılan tanımları Git üzerinden alıp gönderebilmeli; Azure Key Vault değerlerini aynı arayüzde kullanabilmelidir. API tanımları ve secret değerleri farklı kaynaklarda kalır. Bir API deposu GitHub veya Bitbucket üzerinde olabilir; uygulama belirli bir Git sağlayıcısına bağlanmaz.

Bu herkese açık depo **uygulamanın kaynak kodudur**. Kullanıcıların API tanımlarını saklayacağı Git depoları ayrıdır. Bu depoya gerçek API koleksiyonları, vault adresleri, kimlik bilgileri veya kullanıcı verileri eklenmez.

### Temel kullanıcı akışı

1. Kullanıcı uygulamada `Clone Workspace` ile bir Git URL'si verir veya mevcut yerel workspace'i açar.
2. Azure erişimi olmasa da API tanımlarını ve dokümantasyonu görür.
3. `Connect Azure` ile mevcut Azure CLI oturumunu kullanır; seçili ortamın secret'ları tanımlı tek Key Vault'tan okunur.
4. İsterse bazı değerler için kendi yerel değerini girer ve her anahtarın hangi kaynaktan okunacağını seçer.
5. `Local` veya `Remote Sync` modunu seçer. İstek üzerinde çalışırken `Ctrl+S` ile kaydeder.
6. `Remote Sync` modunda uygulama değişiklikleri Git'e gönderir; `Pull` düğmesiyle ekip değişikliklerini alıp arayüzü yeniler.

## 2. Veri kaynakları ve sahiplik

| Veri | Kalıcı kaynak | Git'e gider mi? |
|---|---|---|
| API istekleri, klasörler, testler, scriptler, dokümantasyon | Kullanıcının workspace Git deposu | Evet |
| Ortak, gizli olmayan ortam değerleri ve değişken tanımları | Workspace Git deposu | Evet |
| Vault URL'si, secret adları ve değişken eşleşmeleri | Workspace Git deposu | Evet; yalnızca metadata |
| Kullanıcının yerel key-value değerleri ve kaynak seçimleri | Kullanıcıya özel yerel dosya | Hayır |
| Paylaşılan uzun ömürlü secret değerleri | Tek Azure Key Vault | Hayır |
| Çalışma sırasında üretilen access/refresh token'lar | Uygulama belleği | Hayır |
| Git kimlik bilgileri ve Azure oturumu | İşletim sisteminin mevcut araçları | Hayır |

Vault yapılandırması workspace başına **bir vault** ile sınırlıdır. Ortamlar aynı vault içindeki farklı secret adlarına eşlenebilir. Azure App Configuration kullanılmaz.

## 3. Yerel değer dosyası ve kaynak seçimi

Her yerel workspace için kullanıcı profilinde, Git çalışma ağacının **dışında**, tek bir `values.local.json` dosyası tutulur. Dosyada ortam bazında yerel değerler, her anahtarın seçilmiş kaynağı ve uygulama tercihleri bulunur. Workspace'teki her tanımlı anahtar yerel düzenleyicide görünür; yerel değer girmek isteğe bağlıdır. Dosyanın yolu uygulamada `Open Local Values File` ile görülebilir. Repo klonlandığında veya `Pull` yapıldığında bu dosya değiştirilmez.

Secret olarak işaretlenmiş yerel değerler dosyada şifreli tutulur; anahtar işletim sisteminin güvenli saklama mekanizmasıyla korunur. Güvenli saklama mevcut değilse uygulama secret'ı kalıcı dosyaya yazmaz ve bunu açıkça bildirir. Gizli olmayan yerel değerler okunabilir biçimde tutulabilir. Dosya yazımı atomik yapılır; bozuk ya da eski şema fark edildiğinde mevcut dosya sessizce sıfırlanmaz.

Her anahtar ve ortam için kaynak seçimi kullanıcıya aittir:

| Anahtar türü | Mevcut kaynaklar | İki kaynakta da değer varsa |
|---|---|---|
| Gizli | `Local` veya `Key Vault` | Kullanıcı ilk kullanımda seçer; seçim yerelde saklanır |
| Gizli olmayan | `Local` veya `Workspace` | Kullanıcı ilk kullanımda seçer; seçim yerelde saklanır |

Yalnızca bir kaynakta değer varsa o değer kullanılır. Her iki kaynakta değer bulunduğu halde seçim yoksa uygulama isteği göndermeden önce seçim ister; gizlice öncelik vermez. Seçilen kaynak kullanılamıyorsa diğer kaynağa sessizce geçmez. Yerel bir değeri değiştirmek veya silmek Git'teki tanımı ya da Key Vault secret'ını değiştirmez. Git'teki değer veya Key Vault secret'ı değişse bile `Local` seçimi ve yerel değer korunur. Key Vault değeri yerel dosyaya otomatik kopyalanmaz; kullanıcı isterse `Copy to Local` ile açıkça kopyalar ve bu işlem mevcut bir yerel değeri onay almadan değiştirmez. Arayüz, etkin kaynağı ve uzaktaki değerin mevcut olup olmadığını gösterir; secret içeriğini varsayılan olarak göstermez.

Yerel dosya başka bir bilgisayara otomatik taşınmaz. Kullanıcı isterse yalnızca açık bir `Export Local Values` işlemiyle şifreli bir yedek oluşturabilir; bu özellik ilk sürüm için zorunlu değildir.

## 4. Key Vault okuma davranışı

- İlk sürüm yalnızca **okuma** yapar. `Save`, `Ctrl+S` veya `Remote Sync` Key Vault'a yazmaz.
- Azure kimliği için kullanıcının Azure CLI oturumu kullanılır. Azure oturumu yoksa `Connect Azure` ilgili giriş işlemini başlatır.
- Workspace açıldığında seçili ortamın Git'te tanımlı secret eşleşmeleri Key Vault'tan otomatik çekilir. Ortam değiştiğinde yeni ortamın secret'ları çekilir; `Refresh Secrets` elle yeniden çeker.
- Secret değerleri uygulama belleğinde tutulur ve istek çözümlemesine aktarılır. Log, Git, crash raporu veya düz metin geçici dosyaya yazılmaz. Arayüzde değerler maskelenir.
- İzin yoksa, vault erişilemiyorsa veya eşleşen secret bulunamıyorsa anahtar bazında anlaşılır hata görünür. `Key Vault` kaynağı seçiliyken eksik secret ile istek gönderilmez.
- Sadece tanımlı secret adları için okuma izni yeterli olmalıdır; vault genelinde listeleme izni şart koşulmaz.
- Uzun ömürlü credential ile kısa ömürlü token ayrılır. Mümkün olan akışlarda OAuth token istek anında üretilir ve süresi dolunca yenilenir.

### Sonraki sürüm: Key Vault'a yazma

Secret düzenleme, normal API kaydetmeden ayrı bir `Save to Key Vault` işlemi olacaktır. Hedef vault, ortam ve secret adı kullanıcıya gösterilir. İşlem Azure RBAC ile sınırlandırılır, yeni secret sürümü oluşturur ve sonucu kayda geçirir. Üretim ortamında yazma yetkisi varsayılan olarak verilmez. İlk sürümde bu düğme ve yazma API'si bulunmaz.

## 5. Git ve kayıt davranışı

Uygulama standart Git remote URL'si ve sistemdeki Git kimlik doğrulamasını kullanır. HTTPS ve SSH URL'leri desteklenir. GitHub ve Bitbucket aynı davranışı görür. Her workspace'in takip edilen remote'u ve branch'i arayüzde açıkça görünür.

### Local modu

- `Ctrl+S` veya `Save`, değişmiş API dosyalarını yalnızca yerel çalışma ağacına yazar.
- Otomatik commit, push veya pull çalışmaz. Ağ bağlantısı olmadan düzenleme ve istek çalıştırma mümkündür; Key Vault kaynağı seçilmiş secret'lar için Azure erişimi yine gerekir.
- Mod değiştirmek mevcut yerel değişiklikleri silmez.

### Remote Sync modu

- `Ctrl+S` veya `Save` dosyayı hemen yerelde kaydeder ve arayüzde `Sync pending` gösterir.
- Son kayıt işleminden kısa bir süre sonra, aynı workspace'teki uygun değişiklikler tek commit olarak gruplanır ve takip edilen branch'e push edilir. `Save & Sync` düğmesi beklemeyi atlar.
- Commit'e yalnızca uygulamanın yönettiği workspace tanım dosyaları eklenir. Kaynak kod deposundaki dosyalar, kullanıcıya özel dosyalar ve ilgisiz çalışma ağacı değişiklikleri eklenmez.
- Commit öncesi değişken şeması ve secret sızıntısı kontrol edilir. Kontrol başarısızsa dosya yerelde kalır, commit/push yapılmaz, hata gösterilir.
- Ağ veya kimlik doğrulama hatasında yerel kayıt ve commit korunur; `Sync failed` durumu ve tekrar deneme düğmesi görünür. Başarılı push olmadan `Synced` yazılmaz.
- Remote branch ilerlemişse uygulama önce güncellemeleri alır. Çakışmayan değişiklikleri birleştirir. Çakışma varsa otomatik push durur; arayüz hangi dosya/alanın çakıştığını gösterir ve `Mine`, `Remote` veya elle düzenleme seçeneği sunar. Hiçbir tarafın değişikliği sessizce atılmaz.

### Pull ve arayüz yenileme

- `Pull` düğmesi takip edilen remote/branch'in son halini alır ve başarılı işlemden sonra açık workspace, sidebar ve ilgili sekmeleri yeniler.
- Kaydedilmemiş sekmeler veya senkron bekleyen değişiklikler varsa önce kullanıcıya gösterilir. Pull bunları silmez.
- Remote Sync modunda uygulama açılışta ve belirli aralıklarla güncelleme kontrolü yapar. Temiz çalışma ağacında güncellemeler otomatik uygulanabilir; yerel değişiklik varsa kullanıcı `Pull`/çatışma akışını görür.
- Başka bir kullanıcı push yaptığında bu değişiklik, sonraki kontrol veya `Pull` ile görünür. Gerçek zamanlı sunucu bağlantısı ilk sürümün parçası değildir.

## 6. Kullanıcı arayüzü

Workspace üst çubuğunda şu durumlar ve eylemler bulunur:

- Mod: `Local` / `Remote Sync`
- Git: branch, `Pull`, `Save & Sync`, `Synced` / `Sync pending` / `Sync failed` / `Conflict`
- Azure: `Connect Azure`, vault bağlantı durumu, `Refresh Secrets`
- Değişken düzenleyicisi: anahtar, ortam, tür, `Local` / `Workspace` / `Key Vault` kaynak seçimi ve maskeli değer

Kullanıcı API tanımlarını Azure erişimi olmadan inceleyebilir. İlk çalışma deneyimi, Git URL'sini açmak ve gerekliyse `Connect Azure` demek kadar kısa olmalıdır. Hata mesajları eksik Git yetkisi, Azure oturumu, Key Vault izni, bulunamayan secret ve merge çatışmasını ayrı ayrı anlatır.

## 7. Güvenlik ve veri kaybını önleme

- Workspace deposunda ham secret bulunmaz. Uygulama, secret olarak işaretlenen alanların Git'e yazılmasını engeller.
- Yerel dosya Git deposu dışındadır. Yerel secret değerleri şifreli saklanır.
- Bir kaynağın değeri diğer kaynağın üzerine otomatik yazılmaz; seçim yalnızca okuma önceliğini belirler.
- Git push veya pull başarısız olduğunda son yerel kayıt korunur; kullanıcı bunun senkronize edilmediğini görür.
- Git kimlik doğrulaması uygulamanın kendi token deposunda tutulmaz; sistemin credential helper veya SSH agent'ı kullanılır.
- Key Vault yazma yetkisi ilk sürümde istenmez. Okuma izni, eşlenmiş secret'ları getirmekle sınırlandırılır.
- Telemetri, log ve hata ekranları secret değerlerini maskeleyerek gösterir.

## 8. İlk sürümün kabul koşulları

1. Windows'ta kullanıcı GitHub veya Bitbucket URL'sinden workspace klonlayıp API tanımlarını Azure hesabı olmadan açabilir.
2. Tek Key Vault'a Azure CLI ile bağlanıp seçili ortamın eşlenmiş secret'larını otomatik alabilir ve isteklerde kullanabilir.
3. Aynı anahtar hem yerelde hem Git/Key Vault'ta varsa kaynak seçimi yapılır; yerel dosya pull ile değişmez ve yerel değer hiçbir uzak kaynağa yazılmaz.
4. Local modunda `Ctrl+S` sonrası yalnızca yerel dosyalar değişir; ağ bağlantısı ve Git remote olmadan çalışma sürer.
5. Remote Sync modunda `Ctrl+S` yerel kaydı hemen yapar, değişiklikleri gruplayıp commit/push eder ve sonucu doğru durum etiketiyle gösterir.
6. `Pull` güncel tanımları getirir ve arayüzde gösterir. Açık, kaydedilmemiş içerik kaybolmaz.
7. İki kullanıcının aynı isteği değiştirmesi test edildiğinde çakışma görünür; uygulama hiçbir tarafı sessizce ezmez.
8. Git depolarında, uygulama loglarında ve geçici dosyalarda secret değeri bulunmaz. Key Vault `setSecret` çağrısı yapılmaz.

## 9. Uygulama sırası

1. Fork'un ürün adı, yerel derleme ve workspace açma akışı.
2. Yerel değer dosyası, kaynak seçimi ve istek değişkeni çözümlemesi.
3. Azure CLI ile tek Key Vault okuma ve secret durum ekranı.
4. Local/Remote Sync modu, `Ctrl+S` ile kayıt, gruplanmış commit/push.
5. Pull, arayüz yenileme, çakışma yönetimi ve uçtan uca testler.
6. Sonraki sürümde, RBAC kontrollü Key Vault yazma.

## 10. Son inceleme için kararlar

Bu taslakta şu varsayımlar kullanıldı:

1. Aynı anahtar için iki kaynakta değer varsa uygulama ilk kullanımda kullanıcıya seçim yaptırır; son seçimi yerel dosyada hatırlar.
2. Remote Sync, kayıtları birkaç saniye içinde tek commit'te toplar ve takip edilen branch'e otomatik push eder.
3. Pull düğmesi her modda görünür; Local modunda kullanıcı açıkça basmadıkça uzak işlem yapılmaz.
4. İlk sürüm Windows'ta doğrulanır. Kod yapısı macOS ve Linux desteğine açık tutulur.
5. İlk sürüm Key Vault'a yalnızca okuma erişimi ister; yazma sonraki sürüme bırakılır.

Bu beş karar onaylandıktan sonra ilk uygulama adımı başlar.
