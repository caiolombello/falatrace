// Qt/QML desktop shell.
#include <QGuiApplication>
#include <QQmlApplicationEngine>
#include <QQmlContext>
#include <QQuickWindow>
#include <QProcess>
#include <QJsonDocument>
#include <QJsonObject>
#include <QTimer>
#include <QFile>
#include <QImage>
#include <QSet>
#include <QHash>
#include <QVariantMap>
#include <QJSValue>
#include <QtQuickControls2/QQuickStyle>
#include <MpvQt/mpvabstractitem.h>

class Bridge : public QObject {
  Q_OBJECT
  Q_PROPERTY(bool available READ available NOTIFY availabilityChanged)
public:
  Bridge(const QString &program, const QStringList &arguments, QObject *parent = nullptr) : QObject(parent) {
    connect(&process, &QProcess::started, this, [this] {
      alive = true;
      failureInProgress = false;
      emit availabilityChanged();
    });
    connect(&process, &QProcess::readyReadStandardError, this, [this] { process.readAllStandardError(); });
    connect(&process, &QProcess::errorOccurred, this, [this] { fail("Não foi possível acessar o serviço da biblioteca."); });
    connect(&process, &QProcess::finished, this, [this] { fail("O serviço da biblioteca encerrou."); });
    connect(&process, &QProcess::readyReadStandardOutput, this, [this] {
      output += process.readAllStandardOutput();
      if (output.size() > 32 * 1024 * 1024) { fail("A resposta da biblioteca excedeu o limite."); process.terminate(); return; }
      while (output.contains('\n')) {
        const auto line = output.first(output.indexOf('\n'));
        output.remove(0, line.size() + 1);
        const auto document = QJsonDocument::fromJson(line);
        if (!document.isObject()) { fail("O serviço da biblioteca retornou uma resposta inválida."); process.terminate(); return; }
        const auto message = document.object();
        const int id = message["id"].toInt();
        if (id <= 0 || message["id"].toDouble() != id || !outstanding.contains(id) || !message["ok"].isBool()
            || (message["ok"].toBool() ? !message["result"].isObject() : !message["error"].isString())) {
          fail("O serviço da biblioteca retornou uma resposta inválida.");
          if (process.state() != QProcess::NotRunning) process.terminate();
          return;
        }
        if (outstanding.remove(id)) {
          if (timers.contains(id)) { timers.take(id)->deleteLater(); }
          requestGenerations.remove(id);
          emit response(document.object().toVariantMap());
        }
      }
    });
    this->program = program;
    this->arguments = arguments;
    startProcess();
  }
  ~Bridge() override {
    shuttingDown = true;
    process.closeWriteChannel();
    if (process.state() != QProcess::NotRunning) {
      if (!process.waitForFinished(500)) {
        process.terminate();
        if (!process.waitForFinished(500)) { process.kill(); process.waitForFinished(500); }
      }
    }
  }
  Q_INVOKABLE int request(const QString &op, const QString &key = {}, const QVariantMap &payload = {}) {
    if (!alive || process.state() != QProcess::Running || outstanding.size() >= 32) return -1;
    const int id = ++sequence;
    QJsonObject request{{"id", id}, {"op", op}, {"key", key}, {"payload", QJsonObject::fromVariantMap(payload)}};
    const auto line = QJsonDocument(request).toJson(QJsonDocument::Compact) + '\n';
    if (line.size() > 1024 * 1024) return -1;
    process.write(line);
    outstanding.insert(id);
    const int epoch = processGeneration;
    requestGenerations.insert(id, epoch);
    auto *timer = new QTimer(this);
    timer->setSingleShot(true);
    timer->setInterval(op.startsWith("capture-") ? 120000 : 30000);
    connect(timer, &QTimer::timeout, this, [this, id, epoch] {
      if (epoch == processGeneration && outstanding.contains(id)) {
        fail("A biblioteca demorou demais para responder.");
        if (process.state() != QProcess::NotRunning) process.terminate();
      }
    });
    timers.insert(id, timer);
    timer->start();
    return id;
  }
  Q_INVOKABLE void reconnect() {
    if (alive || process.state() != QProcess::NotRunning) return;
    autoReconnectAttempt = 0;
    failureInProgress = false;
    if (reconnectTimer) { reconnectTimer->stop(); reconnectTimer->deleteLater(); reconnectTimer = nullptr; }
    startProcess();
  }
  bool available() const { return alive; }
signals:
  void response(const QVariantMap &message);
  void failed(const QString &message);
  void availabilityChanged();
private:
  void startProcess() {
    ++processGeneration;
    failureInProgress = false;
    process.start(program, arguments);
  }
  void fail(const QString &message) {
    if (failureInProgress) return;
    failureInProgress = true;
    alive = false; output.clear(); outstanding.clear();
    for (auto *timer : timers) timer->deleteLater();
    timers.clear(); requestGenerations.clear();
    emit availabilityChanged(); emit failed(message);
    if (!shuttingDown && autoReconnectAttempt < 3) {
      const int delay = 1000 << autoReconnectAttempt++;
      reconnectTimer = new QTimer(this);
      reconnectTimer->setSingleShot(true);
      reconnectTimer->setInterval(delay);
      connect(reconnectTimer, &QTimer::timeout, this, [this] {
        if (reconnectTimer) { reconnectTimer->deleteLater(); reconnectTimer = nullptr; }
        if (!alive && process.state() == QProcess::NotRunning) startProcess();
      });
      reconnectTimer->start();
    }
  }
  QString program;
  QStringList arguments;
  QProcess process;
  QByteArray output;
  int sequence = 0;
  int processGeneration = 0;
  int autoReconnectAttempt = 0;
  bool alive = false;
  bool failureInProgress = false;
  bool shuttingDown = false;
  QSet<int> outstanding;
  QHash<int, int> requestGenerations;
  QHash<int, QTimer *> timers;
  QTimer *reconnectTimer = nullptr;
};

int main(int argc, char **argv) {
  qputenv("QT_QUICK_CONTROLS_STYLE", "Basic");
  QQuickWindow::setGraphicsApi(QSGRendererInterface::OpenGL);
  QGuiApplication app(argc, argv);
  QQuickStyle::setStyle("Basic");
  app.setApplicationName("FalaTrace Studio");
  app.setOrganizationName("recording-cli");
  app.setDesktopFileName("recording-studio");
  const auto args = app.arguments();
  if (args.size() < 3) return 2;
  const QString root = args[1];
  const bool packaged = args.size() > 3 && args[3] == "--packaged";
  Bridge bridge(args[2], packaged ? QStringList{"desktop", "bridge"} : QStringList{root + "/bridge.ts"});
  qmlRegisterType<MpvAbstractItem>("Recording", 1, 0, "RecordingVideo");
  QQmlApplicationEngine engine;
  engine.rootContext()->setContextProperty("backend", &bridge);
  engine.rootContext()->setContextProperty("smokeKey", qEnvironmentVariable("RECORDING_DESKTOP_SMOKE_KEY"));
  engine.rootContext()->setContextProperty("smokeSoftware", qEnvironmentVariableIsSet("RECORDING_DESKTOP_SOFTWARE_SMOKE"));
  engine.rootContext()->setContextProperty("smokeDiarization", qEnvironmentVariableIsSet("RECORDING_DESKTOP_DIARIZATION_SMOKE"));
  engine.load(QUrl::fromLocalFile(root + "/Main.qml"));
  if (engine.rootObjects().isEmpty()) return 3;
  const QString snapshot = qEnvironmentVariable("RECORDING_DESKTOP_SNAPSHOT");
  if (qEnvironmentVariableIsSet("RECORDING_DESKTOP_CLOSE_WHILE_RECOVERING")) {
    QObject::connect(&bridge, &Bridge::response, &app, [&](const QVariantMap &message) {
      const auto result = message.value("result").toMap();
      if (result.value("state") != "running" || result.value("operationId").toString().isEmpty()) return;
      QFile evidence(snapshot + ".close.json");
      if (evidence.open(QIODevice::WriteOnly)) evidence.write(QJsonDocument::fromVariant(result).toJson());
      QMetaObject::invokeMethod(engine.rootObjects().first(), "close");
    });
  }
  if (!snapshot.isEmpty()) {
    if (qEnvironmentVariableIsSet("RECORDING_DESKTOP_CONTEXT_SMOKE")) {
      QTimer::singleShot(8000, &app, [&] {
        QMetaObject::invokeMethod(engine.rootObjects().first(), "requestMeetingContext");
      });
    }
    if (!qEnvironmentVariable("RECORDING_DESKTOP_SMOKE_KEY").isEmpty()) {
      QTimer::singleShot(5000, &app, [&] {
        auto window = engine.rootObjects().first();
        auto video = window->findChild<MpvAbstractItem *>("recordingVideo");
        if (!video) return;
        video->setPropertyAsync("mute", true);
        QMetaObject::invokeMethod(window, "seek", Q_ARG(QVariant, 2.0));
        video->setPropertyAsync("pause", false);
      });
    }
    const int delay = qEnvironmentVariableIntValue("RECORDING_DESKTOP_SNAPSHOT_MS");
    QTimer::singleShot(delay > 0 ? delay : 12000, &app, [&] {
      auto window = qobject_cast<QQuickWindow *>(engine.rootObjects().first());
      if (!window) { app.exit(4); return; }
      const bool saved = window->grabWindow().save(snapshot);
      auto video = window->findChild<MpvAbstractItem *>("recordingVideo");
      const auto evidence = QJsonObject{{"snapshot", saved}, {"platform", QGuiApplication::platformName()},
        {"backendAvailable", bridge.available()},
        {"pendingRequests", window->property("pending").value<QJSValue>().toVariant().toMap().size()},
        {"position", window->property("position").toDouble()}, {"duration", window->property("duration").toDouble()},
        {"location", window->property("location").toString()}, {"mediaReady", window->property("mediaReady").toBool()},
        {"error", window->property("errorText").toString()},
        {"initialTranscriptTiming", window->property("initialTranscriptTiming").toString()},
        {"transcriptTiming", window->property("transcriptTiming").toString()},
        {"transcriptSegments", window->property("transcriptSegments").toInt()},
        {"diarizationTurns", window->property("diarizationTurns").toInt()},
        {"diarizationTab", window->property("diarizationTab").toBool()},
        {"contextLoaded", !window->property("contextText").toString().isEmpty()},
        {"contextLoading", window->property("contextLoading").toBool()},
        {"hwdec", video ? video->getProperty("hwdec-current").toString() : ""},
        {"droppedFrames", video ? video->getProperty("frame-drop-count").toInt() : -1}};
      QFile out(snapshot + ".json");
      if (out.open(QIODevice::WriteOnly)) out.write(QJsonDocument(evidence).toJson());
      app.exit(saved && evidence["mediaReady"].toBool() ? 0 : 5);
    });
  }
  return app.exec();
}
#include "main.moc"
