# math-mini — 프론트엔드 전용 (math-app0623 에서 분리)

초등학교 AI 수학 학습 웹앱의 **프론트엔드만** 포함한 버전입니다.  
로컬 Python 백엔드(`backend/`)는 없으며, OCR·스캔정리·AI 검토 등 API는 `.env`의 `REACT_APP_API_BASE`로 원격 서버에 연결합니다.

## 빠른 시작

1. Node.js LTS 설치
2. `.env.example`을 복사해 `.env` 작성 (Firebase·Claude·API URL)
3. 터미널에서 `math-mini` 폴더로 이동 후:

```
npm install
npm start
```

4. 브라우저에서 `http://localhost:3000` 열림

> **참고:** `math-app0623`의 `.env`가 있다면 같은 내용을 `math-mini/.env`에 복사하면 됩니다.

## math-app0623 과의 차이

| 항목 | math-app0623 | math-mini |
|------|--------------|-----------|
| 프론트엔드 (`src/`, `public/`) | ✅ | ✅ |
| 로컬 백엔드 (`backend/`) | ✅ | ❌ |
| 개발 프록시 | Python + Claude | Claude만 |
| API 호출 | 로컬 또는 원격 | 원격 (`REACT_APP_API_BASE`) |

---

# 🧮 수학 문제 만들기 - 설치 및 실행 가이드

초등학교 4학년 AI 수학 학습 웹앱입니다.

---

## 📋 전체 준비물 목록

1. **Node.js** 설치 (프로그램 실행 환경)
2. **Firebase 계정** (데이터베이스 및 로그인 기능)
3. **Claude API 키** (AI 문제 생성)

---

## 🚀 1단계: Node.js 설치

1. https://nodejs.org 접속
2. **LTS 버전** (왼쪽 버튼) 클릭하여 다운로드
3. 다운로드된 파일 실행 → "Next" 계속 클릭하여 설치
4. 설치 완료 후 **명령 프롬프트(cmd)** 열기
   - 윈도우 키 + R → `cmd` 입력 → 엔터
5. 다음 명령어로 설치 확인:
   ```
   node --version
   ```
   `v20.x.x` 처럼 버전이 나오면 성공!

---

## 🔥 2단계: Firebase 프로젝트 만들기

### 2-1. Firebase 콘솔 접속
1. https://console.firebase.google.com 접속
2. 구글 계정으로 로그인

### 2-2. 새 프로젝트 만들기
1. **"프로젝트 추가"** 클릭
2. 프로젝트 이름 입력 (예: `math-app-4grade`)
3. Google Analytics → **사용 안함** 선택
4. **"프로젝트 만들기"** 클릭

### 2-3. 웹 앱 등록
1. 프로젝트 홈에서 `</>` (웹) 아이콘 클릭
2. 앱 닉네임 입력 (예: `수학앱`)
3. **"앱 등록"** 클릭
4. 화면에 나오는 설정값 복사 (아래처럼 생겼어요):
   ```javascript
   const firebaseConfig = {
     apiKey: "AIzaSy...",
     authDomain: "math-app-4grade.firebaseapp.com",
     projectId: "math-app-4grade",
     storageBucket: "math-app-4grade.appspot.com",
     messagingSenderId: "123456789",
     appId: "1:123456789:web:abcdef"
   };
   ```
5. 이 값들을 메모해 두세요

### 2-4. Authentication(인증) 활성화
1. 왼쪽 메뉴 → **"Authentication"** 클릭
2. **"시작하기"** 클릭
3. **"이메일/비밀번호"** 클릭
4. **"사용 설정"** 토글 켜기 → **"저장"**

### 2-5. Firestore Database 생성
1. 왼쪽 메뉴 → **"Firestore Database"** 클릭
2. **"데이터베이스 만들기"** 클릭
3. **"프로덕션 모드에서 시작"** 선택 → **"다음"**
4. 위치 선택: **`asia-northeast3`** (서울) → **"완료"**

### 2-6. Firestore 보안 규칙 설정
1. Firestore → **"규칙"** 탭 클릭
2. 기존 내용 전체 삭제
3. `math-app/firestore.rules` 파일 내용을 전부 복사하여 붙여넣기
4. **"게시"** 클릭

---

## 🔑 3단계: Claude API 키 받기

1. https://console.anthropic.com 접속
2. 회원가입 또는 로그인
3. **"API Keys"** 메뉴 클릭
4. **"Create Key"** 클릭 → 키 이름 입력
5. 생성된 API 키 복사 (sk-ant-... 로 시작)

---

## ⚙️ 4단계: 환경변수 파일(.env) 설정

`math-app` 폴더 안의 `.env` 파일을 메모장으로 열어서
2단계에서 복사한 값으로 교체하세요:

```
REACT_APP_FIREBASE_API_KEY=AIzaSy...여기에_복사한값
REACT_APP_FIREBASE_AUTH_DOMAIN=프로젝트ID.firebaseapp.com
REACT_APP_FIREBASE_PROJECT_ID=프로젝트ID
REACT_APP_FIREBASE_STORAGE_BUCKET=프로젝트ID.appspot.com
REACT_APP_FIREBASE_MESSAGING_SENDER_ID=숫자
REACT_APP_FIREBASE_APP_ID=1:숫자:web:문자열

REACT_APP_CLAUDE_API_KEY=sk-ant-...여기에_복사한값
```

---

## 📦 5단계: 라이브러리 설치 및 실행

1. **명령 프롬프트(cmd)** 열기
2. `math-app` 폴더로 이동:
   ```
   cd "C:\Users\PC\OneDrive\바탕 화면\디지털 교육 연구대회\커서AI(cursor)\math-app"
   ```
3. 라이브러리 설치 (인터넷 연결 필요, 약 2~3분 소요):
   ```
   npm install
   ```
4. 앱 실행:
   ```
   npm start
   ```
5. 브라우저에서 자동으로 `http://localhost:3000` 열림

---

## 👩‍🏫 6단계: 교사 계정 만들기 (최초 1회)

앱을 처음 실행하면 교사 계정을 직접 Firebase에서 만들어야 합니다.

### Firebase Console에서 교사 계정 생성:

1. Firebase 콘솔 → **Authentication** → **사용자** 탭
2. **"사용자 추가"** 클릭
3. 교사 이메일과 비밀번호 입력 → **"사용자 추가"**
4. 생성된 사용자의 **UID** 복사 (오른쪽의 긴 문자열)

### Firestore에 교사 데이터 추가:

1. Firebase 콘솔 → **Firestore Database** → **"컬렉션 시작"**
2. 컬렉션 ID: `users` 입력 → **"다음"**
3. 문서 ID: 위에서 복사한 **UID** 붙여넣기
4. 다음 필드들 추가:
   - `uid` (string): UID값
   - `email` (string): 교사 이메일
   - `name` (string): 교사 이름 (예: `김선생님`)
   - `role` (string): `teacher`
5. **"저장"** 클릭

---

## 🎯 사용 방법

### 교사로 로그인하면:
- 학생 목록 확인
- 학생 계정 추가 (이름, 번호, 이메일, 비밀번호 설정)
- 학생별 학습 통계 확인 (풀이 수, 정답률)

### 학생으로 로그인하면:
- 내 학습 통계 확인
- 단원 선택 (큰 수, 각도, 곱셈과 나눗셈 등)
- 난이도 선택 (쉬움/보통/어려움)
- AI가 만든 5문제 풀기
- 힌트 보기, 풀이 보기
- 결과 확인 및 저장

---

## ❓ 자주 묻는 질문

**Q: `npm install` 실행 시 오류가 나요**
A: Node.js가 제대로 설치되었는지 확인하세요. `node --version` 명령어 실행 결과를 확인하세요.

**Q: 앱이 실행되는데 로그인이 안 돼요**
A: `.env` 파일의 Firebase 설정값이 올바른지 확인하세요.

**Q: 문제가 생성되지 않아요**
A: `.env` 파일의 `REACT_APP_CLAUDE_API_KEY` 값이 올바른지 확인하세요.

**Q: 학생으로 로그인해도 교사 화면이 보여요**
A: Firestore의 해당 사용자 문서에서 `role` 필드가 `student`로 설정되어 있는지 확인하세요.

---

## 📁 파일 구조

```
math-app/
├── .env                          ← Firebase/Claude API 설정값 (직접 수정)
├── .env.example                  ← 설정값 양식 (참고용)
├── package.json                  ← 프로젝트 정보
├── firestore.rules               ← Firestore 보안 규칙
├── public/
│   └── index.html                ← HTML 진입점
└── src/
    ├── index.js                  ← React 시작점
    ├── index.css                 ← 전체 스타일
    ├── App.js                    ← 라우팅 설정
    ├── firebase/
    │   └── config.js             ← Firebase 초기화
    ├── contexts/
    │   └── AuthContext.js        ← 로그인 상태 관리
    └── components/
        ├── Login.js              ← 로그인 화면
        ├── TeacherDashboard.js   ← 교사 대시보드
        └── StudentDashboard.js   ← 학생 메인 메뉴
```
