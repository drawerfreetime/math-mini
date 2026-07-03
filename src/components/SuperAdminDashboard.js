import React, { useState, useEffect } from 'react';
import HudFrame from './HudFrame';
import { collection, getDocs, query, where, orderBy } from 'firebase/firestore';
import { db } from '../firebase/config';
import { useAuth } from '../contexts/AuthContext';
import { useNavigate } from 'react-router-dom';

export default function SuperAdminDashboard() {
  const { currentUser, userProfile, logout, resetPassword } = useAuth();
  const navigate = useNavigate();

  const [teachers, setTeachers]         = useState([]);
  const [classCounts, setClassCounts]   = useState({}); // key: classId, value: count
  const [loadingData, setLoadingData]   = useState(true);
  const [successMsg, setSuccessMsg]     = useState('');
  const [errorMsg, setErrorMsg]         = useState('');
  const [activeTab, setActiveTab]       = useState('teachers'); // teachers | classes

  function showSuccess(msg) {
    setSuccessMsg(msg);
    setTimeout(() => setSuccessMsg(''), 4000);
  }

  async function loadData() {
    setLoadingData(true);
    try {
      // 교사 목록
      const teacherQ = query(
        collection(db, 'users'),
        where('role', '==', 'teacher'),
        orderBy('schoolName', 'asc')
      );
      const teacherSnap = await getDocs(teacherQ);
      const teacherList = teacherSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
      setTeachers(teacherList);

      // 학생 수 집계 (학습 데이터 제외 - users 컬렉션 role/class 정보만)
      const studentQ = query(
        collection(db, 'users'),
        where('role', '==', 'student')
      );
      const studentSnap = await getDocs(studentQ);
      const counts = {};
      studentSnap.docs.forEach((d) => {
        const { schoolName, grade, classNum } = d.data();
        const key = `${schoolName}_${grade}_${classNum}`;
        counts[key] = (counts[key] || 0) + 1;
      });
      setClassCounts(counts);
    } catch (err) {
      setErrorMsg('데이터 로드 오류: ' + err.message);
    }
    setLoadingData(false);
  }

  useEffect(() => { loadData(); }, []);

  async function handleResetPassword(teacher) {
    try {
      await resetPassword(teacher.email);
      showSuccess(`${teacher.name} 선생님(${teacher.email})께 비밀번호 재설정 이메일을 발송했습니다.`);
    } catch (err) {
      setErrorMsg('비밀번호 재설정 오류: ' + err.message);
    }
  }

  async function handleLogout() {
    await logout();
    navigate('/login');
  }

  // 반별 통계를 교사 기준으로 매핑
  const classStats = teachers.map((t) => {
    const key = `${t.schoolName}_${t.grade}_${t.classNum}`;
    return {
      ...t,
      studentCount: classCounts[key] || 0,
      classKey: key,
    };
  });

  const totalStudents = Object.values(classCounts).reduce((s, c) => s + c, 0);

  return (
    <div className="dashboard-container dashboard-container--brand-bg">
      {/* 헤더 */}
      <header className="dashboard-header">
        <div className="header-left">
          <span className="header-icon">🔐</span>
          <div>
            <h1 className="header-title">슈퍼관리자 대시보드</h1>
            <p className="header-subtitle">교사 계정 관리 전용</p>
          </div>
        </div>
        <div className="header-right">
          <span className="user-badge" style={{ background: '#fee2e2', color: '#991b1b' }}>
            슈퍼관리자
          </span>
          <span className="user-name">{userProfile?.name || currentUser?.email}</span>
          <button onClick={handleLogout} className="btn btn-outline btn-sm">로그아웃</button>
        </div>
      </header>

      <main className="dashboard-main">
        {successMsg && (
          <div className="alert alert-success">✅ {successMsg}</div>
        )}
        {errorMsg && (
          <div className="alert alert-error">
            ⚠️ {errorMsg}
            <button className="alert-close" onClick={() => setErrorMsg('')}>×</button>
          </div>
        )}

        {/* 보안 안내 배너 */}
        <div className="info-banner">
          <span className="info-banner-icon">🔒</span>
          <div>
            <strong>보안 정책:</strong> 슈퍼관리자는 교사 계정 정보와 반별 학생 수만 조회할 수 있습니다.
            학생 학습 데이터는 Firestore 보안 규칙에 의해 접근이 차단됩니다.
          </div>
        </div>

        {/* 요약 통계 */}
        <div className="stats-grid">
          <div className="stat-card">
            <div className="stat-icon">👩‍🏫</div>
            <div className="stat-info">
              <p className="stat-label">등록된 교사 수</p>
              <p className="stat-value">{teachers.length}명</p>
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-icon">👨‍🎓</div>
            <div className="stat-info">
              <p className="stat-label">전체 학생 수 (계정 수)</p>
              <p className="stat-value">{totalStudents}명</p>
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-icon">🏫</div>
            <div className="stat-info">
              <p className="stat-label">활성 학급 수</p>
              <p className="stat-value">{Object.keys(classCounts).length}개 반</p>
            </div>
          </div>
        </div>

        {/* 탭 */}
        <div className="tab-bar">
          <button
            className={`tab-btn ${activeTab === 'teachers' ? 'tab-active' : ''}`}
            onClick={() => setActiveTab('teachers')}
          >
            교사 목록 ({teachers.length})
          </button>
          <button
            className={`tab-btn ${activeTab === 'classes' ? 'tab-active' : ''}`}
            onClick={() => setActiveTab('classes')}
          >
            반별 학생 수 ({classStats.length})
          </button>
        </div>

        {loadingData ? (
          <div className="loading-box">
            <div className="spinner-large"></div>
            <p>데이터 불러오는 중...</p>
          </div>
        ) : activeTab === 'teachers' ? (
          // ─── 교사 목록 탭 ───
          <HudFrame>
            <div className="section-header">
              <h2 className="section-title">교사 계정 목록</h2>
              <button className="btn btn-outline btn-sm" onClick={loadData}>
                🔄 새로고침
              </button>
            </div>
            {teachers.length === 0 ? (
              <div className="empty-box">
                <span className="empty-icon">👩‍🏫</span>
                <p>등록된 교사가 없습니다.</p>
              </div>
            ) : (
              <div className="table-wrapper">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>이름</th>
                      <th>학교명</th>
                      <th>담당</th>
                      <th>이메일</th>
                      <th>가입일</th>
                      <th>비밀번호 관리</th>
                    </tr>
                  </thead>
                  <tbody>
                    {teachers.map((t) => (
                      <tr key={t.id}>
                        <td><strong>{t.name}</strong></td>
                        <td>{t.schoolName}</td>
                        <td>
                          <span className="badge badge-gray">
                            {t.grade}학년 {t.classNum}반
                          </span>
                        </td>
                        <td className="text-muted">{t.email}</td>
                        <td className="text-muted">
                          {t.createdAt
                            ? new Date(t.createdAt).toLocaleDateString('ko-KR')
                            : '-'}
                        </td>
                        <td>
                          <button
                            className="btn btn-outline btn-xs"
                            onClick={() => handleResetPassword(t)}
                          >
                            🔑 비밀번호 초기화
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </HudFrame>
        ) : (
          // ─── 반별 학생 수 탭 ───
          <HudFrame>
            <div className="section-header">
              <h2 className="section-title">반별 학생 수 현황</h2>
              <p className="text-muted" style={{ fontSize: 13 }}>
                * 학습 데이터는 표시되지 않습니다
              </p>
            </div>
            {classStats.length === 0 ? (
              <div className="empty-box">
                <span className="empty-icon">🏫</span>
                <p>등록된 학급이 없습니다.</p>
              </div>
            ) : (
              <div className="class-grid">
                {classStats.map((c) => (
                  <div key={c.id} className="class-card">
                    <div className="class-card-top">
                      <span className="class-school">{c.schoolName}</span>
                      <span className="badge badge-gray">{c.grade}학년 {c.classNum}반</span>
                    </div>
                    <div className="class-card-teacher">👩‍🏫 {c.name} 선생님</div>
                    <div className="class-card-count">
                      <span className="class-count-num">{c.studentCount}</span>
                      <span className="class-count-label">명</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </HudFrame>
        )}
      </main>
    </div>
  );
}
